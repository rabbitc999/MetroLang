/**
 * @file lsp.cpp
 * @brief `metro-lang` 内嵌的编辑期语言服务器（仿 Magel 的 `magel lsp`）。
 *
 * 与编译器共用同一个前端（`metro::compileText` / `metro::toHtml`），
 * 因此不需要第二个可执行文件：
 *
 *   metro-lang lsp                          在标准输入输出上跑 LSP（编辑器默认用法）
 *   metro-lang check FILE --diagnostics=json  直接校验，输出稳定的 JSON 诊断
 *
 * LSP 能力：
 *   - textDocument/didOpen · didChange · didClose → publishDiagnostics；
 *   - textDocument/hover：把光标下的标识符解析成模型实体，显示它的类型、定义与属性
 *     （线路 / 车站 / 方向 / 运营参数）；
 *   - textDocument/definition：跳到该标识符在本文档里的定义行；documentSymbol
 *     把顶级块列成大纲，供编辑器导航；
 *   - 自定义请求 `metro/previewMap`：把当前文档编译成自包含 HTML 地图，
 *     供 VS Code 插件的"预览地图"命令放进 Webview（metro_editor 同款渲染）。
 *
 * 诊断的行号来自前端错误文本的 `第 N 行：` 前缀；语义层暂时没有列号与
 * 位置锚点，这类错误整行标红、定位到第 1 行。
 */
#include "metro_model.hpp"

#include "lsp.hpp"
#include "lsp_index.hpp"

#include "preprocess.hpp"

#include "lsp/json.hpp"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#if defined(_WIN32)
#include <fcntl.h>
#include <io.h>
#endif
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

namespace {

using lsp::Json;

/** @brief 造一个空对象。 */
Json object() { return Json::object(); }
/** @brief 造一个空数组。 */
Json array() { return Json::array(); }

/** @brief 一条结构化诊断（LSP 报文与 JSON 导出共用）。 */
struct Diag {
    int line = 0;        ///< 0 起算的行号。
    int lineLength = 0;  ///< 该行长度（列区间用）。
    int severity = 1;    ///< 1 = Error（MetroLang 前端只产错误）。
    std::string code;    ///< 稳定短码，如 metro-syntax / metro-semantic。
    std::string message; ///< 错误文本（不带 `第 N 行：` 前缀）。
};

/** @brief 一个已打开文档的状态。 */
struct Doc {
    std::string text;       ///< 最近一次同步的全文。
    std::vector<Diag> diags;///< 最近一次检查的诊断。
    bool ok = false;        ///< 最近一次编译是否通过。
    metro::Program program; ///< 最近一次成功编译的模型（失败时保留上一次的）。
    metro::SourceIndex index; ///< 语义索引（hover / definition 用）。
};

/**
 * @brief 去掉错误文本里的 `第 N 行：` 前缀并取出行号。
 *
 * 前端语义动作产的是 `"第 12 行：xxx"`；解析器错误还带一截上下文行。
 * 拆开后：line = N-1（0 起算），message = 余下文本（上下文行去掉）。
 *
 * @param error 前端错误原文。
 * @param outLine 输出 0 起算的行号；没有前缀时为 0。
 * @param outMessage 输出去掉前缀与上下文行后的消息。
 */
void splitError(const std::string &error, int &outLine, std::string &outMessage) {
    static const std::string prefix = "\xE7\xAC\xAC ";  // "第 "
    static const std::string mid = " \xE8\xA1\x8C\xEF\xBC\x9A";  // " 行："
    outLine = 0;
    std::string rest = error;
    if (error.rfind(prefix, 0) == 0) {
        const std::size_t digitsEnd = error.find_first_not_of("0123456789", prefix.size());
        if (digitsEnd != std::string::npos &&
            error.compare(digitsEnd, mid.size(), mid) == 0) {
            const std::string digits = error.substr(prefix.size(), digitsEnd - prefix.size());
            outLine = std::max(0, std::atoi(digits.c_str()) - 1);
            rest = error.substr(digitsEnd + mid.size());
        }
    }
    // 解析器错误在消息后附一截缩进的上下文行，诊断里不需要。
    const std::size_t contextAt = rest.find("\n          ");
    if (contextAt != std::string::npos) rest = rest.substr(0, contextAt);
    outMessage = rest;
}

/**
 * @brief 把前端错误列表转成结构化诊断。
 *
 * 语义错误（如 `STATION_MODIFY 找不到站点：X`）没有行号：定位到第 1 行，
 * 整行区间，码为 metro-semantic。
 *
 * @param text 文档全文（用来取行长度，好铺整行区间）。
 * @param errors 前端错误列表。
 * @return 结构化诊断列表。
 */
std::vector<Diag> toDiags(const std::string &text, const std::vector<std::string> &errors) {
    // 预先把全文拆成行，取每行的字节长度（LSP 的 character 按 UTF-16 计，
    // 但 MetroLang 源码基本是 ASCII 块头 + 中文串，这里按字节长度近似即可）。
    std::vector<int> lineLengths;
    {
        std::istringstream in(text);
        std::string line;
        while (std::getline(in, line)) {
            if (!line.empty() && line.back() == '\r') line.pop_back();
            lineLengths.push_back(static_cast<int>(line.size()));
        }
        if (lineLengths.empty()) lineLengths.push_back(0);
    }

    std::vector<Diag> diags;
    for (const std::string &error : errors) {
        Diag diag;
        std::string message;
        splitError(error, diag.line, message);
        diag.message = message;
        diag.code = diag.line > 0 || error.rfind("\xE7\xAC\xAC ", 0) == 0 ? "metro-syntax"
                                                                          : "metro-semantic";
        if (diag.line >= static_cast<int>(lineLengths.size()))
            diag.line = static_cast<int>(lineLengths.size()) - 1;
        diag.lineLength = lineLengths[static_cast<std::size_t>(diag.line)];
        diags.push_back(std::move(diag));
    }
    return diags;
}

/**
 * @brief 从 LSP 的 file:// URI 解出文件目录，给预处理当基准目录。
 *
 * @param uri 文档 URI；不是 file:// 或解不出来时返回空串。
 * @return 目录（不带结尾斜杠），如 `D:/data/metro`。
 */
std::string directoryOfUri(const std::string &uri) {
    static const std::string scheme = "file:///";
    if (uri.rfind(scheme, 0) != 0) return {};
    std::string path = uri.substr(scheme.size());
    // 百分号解码（%20 空格这类）。
    std::string decoded;
    for (std::size_t i = 0; i < path.size(); ++i) {
        if (path[i] == '%' && i + 2 < path.size() &&
            std::isxdigit(static_cast<unsigned char>(path[i + 1])) &&
            std::isxdigit(static_cast<unsigned char>(path[i + 2]))) {
            const std::string hex = path.substr(i + 1, 2);
            decoded.push_back(static_cast<char>(std::strtol(hex.c_str(), nullptr, 16)));
            i += 2;
        } else {
            decoded.push_back(path[i]);
        }
    }
    const std::size_t slash = decoded.find_last_of("/\\");
    return slash == std::string::npos ? std::string() : decoded.substr(0, slash);
}

/**
 * @brief 编辑期编译管线：预处理 + 语法分析，与 compileFile 保持一致。
 *
 * 行号按预处理后的文本计——MetroLang 的预处理只动 %指令行与 CSV 展开，
 * 正文行号通常不漂移。磁盘文档会把文件目录作为 %include / %IMPORT 的
 * 基准目录传下去，未保存的缓冲区（无 file:// URI）解析不了相对路径。
 *
 * @param text 编辑器全文。
 * @param baseDir %include / %IMPORT 相对路径的基准目录；可为空。
 * @param outDiags 输出结构化诊断。
 * @param outProgram 编译成功时输出模型（可为 nullptr）。
 * @return 编译是否通过。
 */
bool compileEditor(const std::string &text, const std::string &baseDir,
                   std::vector<Diag> &outDiags, metro::Program *outProgram = nullptr) {
    preprocess::Options options = preprocess::Preprocessor::forMetro();
    // 与 compileFile 相同的 CSV 装载行为：%IMPORT 拉进来的站表按
    // STATION_DEFINE 内联，而不是当 MetroLang 源码喂给分析器。
    options.includeLoader = [](const preprocess::IncludeRequest &request) {
        if (!request.imported) return preprocess::IncludeResult::useDefault();
        std::string lower = request.resolvedPath;
        for (char &c : lower) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        if (lower.size() < 4 || lower.compare(lower.size() - 4, 4, ".csv") != 0)
            return preprocess::IncludeResult::useDefault();
        std::ifstream in(request.resolvedPath, std::ios::binary);
        if (!in) return preprocess::IncludeResult::useDefault();
        std::ostringstream ss;
        ss << in.rdbuf();
        return preprocess::IncludeResult::inlineText(metro::csvToStationBlock(ss.str()),
                                                     request.resolvedPath);
    };
    preprocess::Preprocessor preprocessor(options);
    preprocess::Result result;
    std::vector<std::string> errors;
    std::string expanded = text;
    if (!preprocessor.runText(text, "editor",
                              baseDir.empty() ? std::string(".") : baseDir, result)) {
        for (const preprocess::Diagnostic &d : result.diagnostics) errors.push_back(d.toString());
    } else {
        expanded = result.text;
        metro::Program program;
        const bool ok = metro::compileText(result.text, program, errors);
        if (ok && outProgram != nullptr) *outProgram = std::move(program);
    }
    // 行长度取展开后文本的（诊断的行号在展开文本上才有意义）。
    outDiags = toDiags(expanded, errors);
    return errors.empty();
}

bool checkText(const std::string &text, const std::string &baseDir,
               std::vector<Diag> &outDiags) {
    return compileEditor(text, baseDir, outDiags);
}

/** @brief 诊断 → LSP 的 range JSON。 */
Json rangeJson(const Diag &diag) {
    Json start = object();
    start.set("line", Json::integer(diag.line));
    start.set("character", Json::integer(0));
    Json end = object();
    end.set("line", Json::integer(diag.line));
    end.set("character", Json::integer(std::max(0, diag.lineLength)));
    Json range = object();
    range.set("start", std::move(start));
    range.set("end", std::move(end));
    return range;
}

/** @brief 诊断 → LSP 的诊断项 JSON。 */
Json diagJson(const Diag &diag) {
    Json item = object();
    item.set("range", rangeJson(diag));
    item.set("severity", Json::integer(diag.severity));
    item.set("code", Json::string(diag.code));
    item.set("source", Json::string("metro-lang"));
    item.set("message", Json::string(diag.message));
    return item;
}

/** @brief 给报文加 Content-Length 帧。 */
std::string frameMessage(const std::string &payload) {
    return "Content-Length: " + std::to_string(payload.size()) + "\r\n\r\n" + payload;
}

/** @brief `["markdown", "plaintext"]`：hover 的内容格式协商。 */
Json markdownArray() {
    Json list = array();
    list.push(Json::string("markdown"));
    list.push(Json::string("plaintext"));
    return list;
}

/** @brief 补全触发字符：空格后是块头的常见位置，`'` 之后是站名。 */
Json triggerArray() {
    Json list = array();
    list.push(Json::string(" "));
    list.push(Json::string("'"));
    return list;
}

/** @brief LSP 的 Position → 行 / 字节列。 */
void positionOf(const Json &params, int &outLine, std::size_t &outColumn) {
    const Json position = params.get("position");
    outLine = static_cast<int>(position.getInteger("line", 0));
    outColumn = static_cast<std::size_t>(std::max<long long>(0, position.getInteger("character", 0)));
}

/** @brief 造一个 LSP Range。 */
Json rangeOf(int line, std::size_t begin, std::size_t end) {
    Json start = object();
    start.set("line", Json::integer(line));
    start.set("character", Json::integer(static_cast<long long>(begin)));
    Json finish = object();
    finish.set("line", Json::integer(line));
    finish.set("character", Json::integer(static_cast<long long>(std::max(begin, end))));
    Json range = object();
    range.set("start", std::move(start));
    range.set("end", std::move(finish));
    return range;
}

/**
 * @brief 从输入流读一帧带 Content-Length 的报文。
 *
 * @param in 输入流。
 * @param payload 输出正文。
 * @param error 输出失败原因；非空表示流已坏，应退出循环。
 * @return 是否读到了一帧。
 */
bool readMessage(std::istream &in, std::string &payload, std::string &error) {
    payload.clear();
    error.clear();
    std::string line;
    std::size_t length = 0;
    bool hasLength = false;
    while (std::getline(in, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (line.empty()) break;
        const std::size_t colon = line.find(':');
        if (colon == std::string::npos) continue;
        std::string key = line.substr(0, colon);
        std::transform(key.begin(), key.end(), key.begin(),
                       [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        if (key == "content-length") {
            length = static_cast<std::size_t>(std::strtoull(line.c_str() + colon + 1, nullptr, 10));
            hasLength = true;
        }
    }
    if (!hasLength) return false;
    payload.resize(length);
    if (length > 0) in.read(&payload[0], static_cast<std::streamsize>(length));
    if (static_cast<std::size_t>(in.gcount()) != length) {
        error = "truncated message";
        return false;
    }
    return true;
}

/** @brief 内嵌语言服务器：文档状态 + 消息派发。 */
class Server {
public:
    /** @brief 处理一条 JSON-RPC 报文，返回要写回的帧（可能为空）。 */
    std::string handleMessage(const std::string &payload) {
        Json message;
        std::string parseError;
        if (!Json::parse(payload, message, &parseError))
            return frameMessage(errorResponse(Json::null(), -32700, "JSON 解析失败：" + parseError).dump());

        const Json *id = message.find("id");
        const bool isRequest = id != nullptr && !id->isNull();
        const Json requestId = (id != nullptr) ? *id : Json::null();
        const std::string method = message.getString("method");
        const Json params = message.get("params");
        if (method.empty()) return {};

        if (method == "initialize") {
            Json sync = object();
            sync.set("openClose", Json::boolean(true));
            sync.set("change", Json::integer(1));  // 全量同步
            Json capabilities = object();
            capabilities.set("textDocumentSync", std::move(sync));
            // 语义提示：光标悬停看标识符的类型与定义。
            Json hover = object();
            hover.set("contentFormat", markdownArray());
            capabilities.set("hoverProvider", std::move(hover));
            // 跳转到定义 + 大纲。
            capabilities.set("definitionProvider", Json::boolean(true));
            capabilities.set("documentSymbolProvider", Json::boolean(true));
            // 补全：块头关键字与站名 / 线路 ID。
            Json completion = object();
            completion.set("triggerCharacters", triggerArray());
            capabilities.set("completionProvider", std::move(completion));
            Json info = object();
            info.set("name", Json::string("metro-lang"));
            info.set("version", Json::string("1.1.0"));
            Json result = object();
            result.set("capabilities", std::move(capabilities));
            result.set("serverInfo", std::move(info));
            return frameMessage(response(requestId, std::move(result)).dump());
        }
        if (method == "initialized") return {};
        if (method == "shutdown") {
            shutdown_ = true;
            return frameMessage(response(requestId, Json::null()).dump());
        }
        if (method == "exit") {
            exit_ = true;
            exitCode_ = shutdown_ ? 0 : 1;
            return {};
        }
        if (method == "$/cancelRequest") return {};

        if (method == "textDocument/didOpen" || method == "textDocument/didChange") {
            const Json textDocument = params.get("textDocument");
            const std::string uri = textDocument.getString("uri");
            if (uri.empty()) return {};
            std::string text = textDocument.getString("text");
            if (method == "textDocument/didChange") {
                const Json changeList = params.get("contentChanges");
                if (changeList.isArray() && changeList.size() > 0)
                    text = changeList.items().back().getString("text");
            }
            Doc &doc = documents_[uri];
            doc.text = text;
            metro::Program program;
            std::vector<Diag> diags;
            doc.ok = compileEditor(text, directoryOfUri(uri), diags, &program);
            // 编译失败时索引也要重建：标识符提示恰恰在写错的时候最有用，
            // 此时沿用上一次成功的模型（没有的话就是空模型，只认关键字）。
            if (doc.ok) doc.program = std::move(program);
            doc.diags = std::move(diags);
            doc.index.build(doc.program, doc.text);
            Json notification = publishDiagnostics(uri, doc);
            return frameMessage(notification.dump());
        }
        if (method == "textDocument/didClose") {
            const Json textDocument = params.get("textDocument");
            const std::string uri = textDocument.getString("uri");
            documents_.erase(uri);
            Json paramsOut = object();
            paramsOut.set("uri", Json::string(uri));
            paramsOut.set("diagnostics", array());
            Json notification = object();
            notification.set("jsonrpc", Json::string("2.0"));
            notification.set("method", Json::string("textDocument/publishDiagnostics"));
            notification.set("params", std::move(paramsOut));
            return frameMessage(notification.dump());
        }

        // ---- 语义提示：悬停看标识符的类型 / 定义 / 属性 ----
        if (method == "textDocument/hover") {
            Doc *doc = findDoc(params);
            if (doc == nullptr) return frameMessage(response(requestId, Json::null()).dump());
            int line = 0;
            std::size_t column = 0;
            positionOf(params, line, column);
            const metro::IndexEntry *entry = doc->index.lookup(line, column);
            if (entry == nullptr) return frameMessage(response(requestId, Json::null()).dump());

            // hover 的内容：一行签名（代码块）+ markdown 说明 + 定义位置。
            std::string text = "```metrolang\n" + entry->signature + "\n```\n\n" + entry->doc;
            if (!entry->declaration)
                text += "\n\n---\n定义于第 " + std::to_string(entry->line + 1) + " 行（`" +
                        entry->kind + "`）";
            else
                text += "\n\n---\n*此处即定义*（`" + entry->kind + "`）";

            Json contents = object();
            contents.set("kind", Json::string("markdown"));
            contents.set("value", Json::string(text));
            Json result = object();
            result.set("contents", std::move(contents));
            result.set("range", rangeOf(entry->line, entry->column,
                                        entry->column + entry->length));
            return frameMessage(response(requestId, std::move(result)).dump());
        }

        // ---- 跳转到定义：本文件里所有同名定义 ----
        if (method == "textDocument/definition") {
            Doc *doc = findDoc(params);
            if (doc == nullptr) return frameMessage(response(requestId, array()).dump());
            int line = 0;
            std::size_t column = 0;
            positionOf(params, line, column);
            const metro::IndexEntry *entry = doc->index.lookup(line, column);
            const std::string uri = documentUri(params);
            Json locations = array();
            if (entry != nullptr) {
                for (const metro::IndexEntry *candidate : doc->index.definitionsOf(entry->name)) {
                    if (!candidate->declaration) continue;
                    Json location = object();
                    location.set("uri", Json::string(uri));
                    location.set("range", rangeOf(candidate->line, candidate->column,
                                                  candidate->column + candidate->length));
                    locations.push(std::move(location));
                }
                // 引用处只找到引用（模型里没有对应定义）：退回自己，至少把光标留下。
                if (locations.size() == 0) {
                    Json location = object();
                    location.set("uri", Json::string(uri));
                    location.set("range", rangeOf(entry->line, entry->column,
                                                  entry->column + entry->length));
                    locations.push(std::move(location));
                }
            }
            return frameMessage(response(requestId, std::move(locations)).dump());
        }

        // ---- 大纲：把定义类记录按行顺序列出来 ----
        if (method == "textDocument/documentSymbol") {
            Doc *doc = findDoc(params);
            if (doc == nullptr) return frameMessage(response(requestId, array()).dump());
            Json symbols = array();
            for (const metro::IndexEntry &entry : doc->index.entries()) {
                if (!entry.declaration) continue;
                Json symbol = object();
                symbol.set("name", Json::string(entry.name));
                // 1 File 2 Module 3 Namespace 4 Package 5 Class 6 Method 7 Property
                // 8 Field 9 Constructor 10 Enum 11 Interface 12 Function 13 Variable
                // 14 Constant 15 String 16 Number 17 Boolean 18 Array 19 Object
                // 20 Key 21 Null 22 EnumMember 23 Struct 24 Event 25 Operator 26 TypeParameter
                long long kind = 13;  // Variable
                if (entry.kind == "line") kind = 5;         // Class
                else if (entry.kind == "station") kind = 23; // Struct
                else if (entry.kind == "direction") kind = 12; // Function
                else if (entry.kind == "operation") kind = 14; // Constant
                symbol.set("kind", Json::integer(kind));
                symbol.set("detail", Json::string(entry.kind));
                symbol.set("range", rangeOf(entry.line, 0, 0));
                symbol.set("selectionRange",
                           rangeOf(entry.line, entry.column, entry.column + entry.length));
                symbols.push(std::move(symbol));
            }
            return frameMessage(response(requestId, std::move(symbols)).dump());
        }

        // ---- 补全：块头关键字 + 站名 + 线路 ID ----
        if (method == "textDocument/completion") {
            Doc *doc = findDoc(params);
            if (doc == nullptr) return frameMessage(response(requestId, array()).dump());
            Json items = array();
            for (const metro::IndexEntry &entry : doc->index.entries()) {
                if (!entry.declaration) continue;
                Json item = object();
                item.set("label", Json::string(entry.name));
                item.set("kind", Json::integer(entry.kind == "station" ? 23 : 5));
                item.set("detail", Json::string(entry.signature));
                item.set("documentation", Json::string(entry.doc));
                items.push(std::move(item));
            }
            return frameMessage(response(requestId, std::move(items)).dump());
        }

        // 自定义请求：路线查询（与 `metro-lang route` 同一个 planRoute）。
        if (method == "metro/route") {
            Doc *doc = findDoc(params);
            if (doc == nullptr)
                return frameMessage(errorResponse(requestId, -32602, "未打开的文档").dump());
            metro::Program program;
            std::vector<Diag> diags;
            if (!compileEditor(doc->text, directoryOfUri(documentUri(params)), diags, &program)) {
                Json result = object();
                result.set("ok", Json::boolean(false));
                result.set("error", Json::string(diags.empty() ? "编译失败" : diags.front().message));
                return frameMessage(response(requestId, std::move(result)).dump());
            }
            metro::RouteOptions options;
            const std::string clock = params.getString("time");
            if (!clock.empty()) {
                int hh = 0, mm = 0;
                if (std::sscanf(clock.c_str(), "%d:%d", &hh, &mm) == 2 && hh >= 0 && hh < 24 &&
                    mm >= 0 && mm < 60) {
                    std::time_t now = std::time(nullptr);
                    std::tm local{};
#if defined(_WIN32)
                    localtime_s(&local, &now);
#else
                    localtime_r(&now, &local);
#endif
                    local.tm_hour = hh;
                    local.tm_min = mm;
                    local.tm_sec = 0;
                    local.tm_isdst = -1;
                    options.timestamp = static_cast<std::int64_t>(std::mktime(&local));
                }
            }
            const metro::RouteResult route =
                metro::planRoute(program, params.getString("from"), params.getString("to"), options);
            Json result = object();
            result.set("ok", Json::boolean(route.found));
            if (!route.found) {
                result.set("error", Json::string(route.error));
                return frameMessage(response(requestId, std::move(result)).dump());
            }
            result.set("guidance", Json::string(route.guidance()));
            result.set("distanceKm", Json::number(route.distanceKm));
            result.set("totalSeconds", Json::number(route.totalSeconds));
            result.set("fare", Json::number(route.fare));
            result.set("transfers", Json::integer(route.transfers));
            // 输出面板里逐行显示，格式与 CLI 的文本输出一致。
            Json lines = array();
            char buffer[256];
            for (const metro::RouteSegment &segment : route.segments) {
                std::snprintf(buffer, sizeof buffer, "%s（开往 %s）  %s → %s  %d 站 / %.2f km",
                              segment.lineName.c_str(), segment.towards.c_str(),
                              segment.from.c_str(), segment.to.c_str(), segment.stations,
                              segment.distanceKm);
                lines.push(Json::string(buffer));
            }
            std::snprintf(buffer, sizeof buffer,
                          "合计 %.2f km，换乘 %d 次，%d 站；总计 %ld 分 %ld 秒；票价 %.1f 元",
                          route.distanceKm, route.transfers, route.stops,
                          static_cast<long>(route.totalSeconds / 60),
                          static_cast<long>(route.totalSeconds) % 60, route.fare);
            lines.push(Json::string(buffer));
            result.set("lines", std::move(lines));
            return frameMessage(response(requestId, std::move(result)).dump());
        }

        // 自定义请求：数据预览（线路 / 车站 / 换乘 / 运营规则 / 未建模行）。
        if (method == "metro/dataSummary") {
            Doc *doc = findDoc(params);
            if (doc == nullptr)
                return frameMessage(errorResponse(requestId, -32602, "未打开的文档").dump());
            metro::Program program;
            std::vector<Diag> diags;
            if (!compileEditor(doc->text, directoryOfUri(documentUri(params)), diags, &program)) {
                Json result = object();
                result.set("ok", Json::boolean(false));
                result.set("error", Json::string(diags.empty() ? "编译失败" : diags.front().message));
                return frameMessage(response(requestId, std::move(result)).dump());
            }
            std::size_t directions = 0, stationCount = 0;
            for (const metro::Line &line : program.lines) directions += line.directions.size();
            for (const metro::Station &station : program.stations)
                if (station.hasCoord) ++stationCount;

            Json rows = array();
            auto addRow = [&rows](const char *name, const std::string &value) {
                Json row = array();
                row.push(Json::string(name));
                row.push(Json::string(value));
                rows.push(std::move(row));
            };
            addRow("主城市", program.keyCity.empty() ? "（未设置）" : program.keyCity);
            addRow("线路", std::to_string(program.lines.size()));
            addRow("车站", std::to_string(program.stations.size()));
            addRow("有坐标的站", std::to_string(stationCount) + " / " +
                                     std::to_string(program.stations.size()));
            addRow("方向", std::to_string(directions));
            addRow("换乘规则", std::to_string(program.transfers.size()));
            addRow("运营时间", std::to_string(program.openTimes.size()));
            addRow("发车间隔表", std::to_string(program.headways.size()) + " 条线路");
            addRow("拥挤度表", std::to_string(program.crowds.size()) + " 个方向");
            addRow("停站覆盖", std::to_string(program.dwellRules.size()) + " 条");
            addRow("区间限速", std::to_string(program.speedLimits.size()) + " 条");
            addRow("特殊线路票价", std::to_string(program.specialLines.size()) + " 条");
            addRow("票价阶梯", std::to_string(program.segments.size()) + " 档");
            addRow("未建模块", std::to_string(program.raw.size()) + " 行");

            Json result = object();
            result.set("ok", Json::boolean(true));
            result.set("rows", std::move(rows));
            return frameMessage(response(requestId, std::move(result)).dump());
        }

        // 自定义请求：把当前文档编译成自包含 HTML 地图（metro_editor 同款渲染）。
        if (method == "metro/previewMap") {
            const Json textDocument = params.get("textDocument");
            const std::string uri = textDocument.getString("uri");
            const auto found = documents_.find(uri);
            if (found == documents_.end())
                return isRequest ? frameMessage(errorResponse(requestId, -32602, "未打开的文本文档").dump())
                                 : std::string();
            Doc &doc = found->second;
            // 用编辑器里的最新文本重新编一遍（诊断可能已过期）。
            metro::Program program;
            std::vector<Diag> diags;
            const bool ok = compileEditor(doc.text, directoryOfUri(uri), diags, &program);
            Json result = object();
            result.set("ok", Json::boolean(ok));
            result.set("html", Json::string(ok ? metro::toHtml(program) : std::string()));
            if (!ok) {
                Json errorList = array();
                for (const Diag &d : diags) errorList.push(Json::string(d.message));
                result.set("errors", std::move(errorList));
            }
            return frameMessage(response(requestId, std::move(result)).dump());
        }

        if (isRequest)
            return frameMessage(errorResponse(requestId, -32601, "未实现的方法：" + method).dump());
        return {};
    }

    bool exited() const { return exit_; }
    int exitCode() const { return exitCode_; }

private:
    /** @brief JSON-RPC 成功响应。 */
    Json response(const Json &id, Json result) const {
        Json message = object();
        message.set("jsonrpc", Json::string("2.0"));
        message.set("id", id);
        message.set("result", std::move(result));
        return message;
    }
    /** @brief JSON-RPC 错误响应。 */
    Json errorResponse(const Json &id, int code, const std::string &text) const {
        Json message = object();
        message.set("jsonrpc", Json::string("2.0"));
        message.set("id", id);
        Json error = object();
        error.set("code", Json::integer(code));
        error.set("message", Json::string(text));
        message.set("error", std::move(error));
        return message;
    }
    /** @brief 取 `params.textDocument.uri`。 */
    static std::string documentUri(const Json &params) {
        return params.get("textDocument").getString("uri");
    }

    /** @brief 按 URI 找已打开文档；没有返回 nullptr。 */
    Doc *findDoc(const Json &params) {
        const std::string uri = documentUri(params);
        if (uri.empty()) return nullptr;
        const auto found = documents_.find(uri);
        return found == documents_.end() ? nullptr : &found->second;
    }

    /** @brief publishDiagnostics 通知。 */
    Json publishDiagnostics(const std::string &uri, const Doc &doc) const {
        Json items = array();
        for (const Diag &diag : doc.diags) items.push(diagJson(diag));
        Json paramsOut = object();
        paramsOut.set("uri", Json::string(uri));
        paramsOut.set("diagnostics", std::move(items));
        Json notification = object();
        notification.set("jsonrpc", Json::string("2.0"));
        notification.set("method", Json::string("textDocument/publishDiagnostics"));
        notification.set("params", std::move(paramsOut));
        return notification;
    }

    std::unordered_map<std::string, Doc> documents_;
    bool shutdown_ = false;
    bool exit_ = false;
    int exitCode_ = 0;
};

/** @brief 在标准输入输出上运行语言服务器，返回进程退出码。 */
int runStdioServer() {
    // Windows 上 stdio 缺省是文本模式：\n 会被翻成 \r\n，把 LSP 的
    // "Content-Length: N\r\n\r\n" 帧头搅成 \r\r\n。这里强制二进制。
#if defined(_WIN32)
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    Server server;
    while (!server.exited()) {
        std::string payload;
        std::string error;
        if (!readMessage(std::cin, payload, error)) {
            if (!error.empty()) std::cerr << "读取 LSP 消息失败：" << error << "\n";
            break;
        }
        const std::string response = server.handleMessage(payload);
        if (!response.empty()) {
            std::cout << response;
            std::cout.flush();
        }
    }
    return server.exitCode();
}

/**
 * @brief `check FILE --diagnostics=json`：走完整 compileFile（含 %IMPORT CSV），
 *        输出稳定 JSON 诊断。
 *
 * @param path 待检查的 .metro 文件。
 * @return 进程退出码：0 无错误，1 有错误。
 */
int runJsonCheck(const std::string &path) {
    metro::Program program;
    std::vector<std::string> errors;
    const bool ok = metro::compileFile(path, program, errors);
    std::string text;
    {
        std::ifstream in(path, std::ios::binary);
        std::ostringstream ss;
        ss << in.rdbuf();
        text = ss.str();
    }
    const std::vector<Diag> diags = toDiags(text, errors);
    Json items = array();
    for (const Diag &diag : diags) items.push(diagJson(diag));
    Json result = object();
    result.set("file", Json::string(path));
    result.set("ok", Json::boolean(ok));
    result.set("diagnostics", std::move(items));
    std::cout << result.dump(2) << "\n";
    return ok ? 0 : 1;
}

} // namespace

namespace metro {

int runLspCommand(const std::vector<std::string> &args, bool diagnosticsJson,
                  const std::string &file) {
    (void)args;
    if (diagnosticsJson) return runJsonCheck(file);
    return runStdioServer();
}

} // namespace metro
