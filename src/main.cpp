/**
 * @file main.cpp
 * @brief `metro-lang` 命令行：compile / decompile / html / game / route / coords / check / lsp。
 */
#include "metro_model.hpp"

#include "game_data.hpp"
#include "lsp.hpp"

#if defined(_WIN32)
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  ifndef NOMINMAX
#    define NOMINMAX
#  endif
#  include <windows.h>
#  include <shellapi.h>   // CommandLineToArgvW
#endif

#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace {

/** @brief 把字符串写成 JSON 字面量（只转义必须转义的字符）。 */
std::string quote(const std::string &s) {
    std::string out;
    out.reserve(s.size() + 2);
    out.push_back('"');
    for (const char c : s) {
        switch (c) {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default:
            if (static_cast<unsigned char>(c) < 0x20) {
                char buf[8];
                std::snprintf(buf, sizeof buf, "\\u%04x", static_cast<unsigned char>(c));
                out += buf;
            } else {
                out.push_back(c);
            }
        }
    }
    out.push_back('"');
    return out;
}

/** @brief 读整个文件。 */
bool readFile(const std::string &path, std::string &out) {
    std::ifstream in(path, std::ios::binary);
    if (!in) return false;
    std::ostringstream ss;
    ss << in.rdbuf();
    out = ss.str();
    return true;
}

/** @brief 写整个文件。 */
bool writeFile(const std::string &path, const std::string &text) {
    std::ofstream out(path, std::ios::binary);
    if (!out) return false;
    out << text;
    return true;
}

/** @brief 打印用法。 */
void usage() {
    std::cout << "用法：metro-lang <命令> [选项]\n"
                 "  compile <file.metro> [-o out.json]      编译为 JSON\n"
                 "  decompile <file.json> [-o out.metro]    反编译为 MetroLang\n"
                 "  html <file.metro> [-o out.html]         生成自包含地图\n"
                 "  game <file.metro> [-o out.html]         生成自包含的线网调度游戏\n"
                 "  route <file.metro> --from A --to B      查询最短时间路径\n"
                 "  coords <file.metro> [--from-coord=gcj]  坐标校正体检（gcj / wgs / auto）\n"
                 "  check <file.metro> [--diagnostics=json] 解析并打印统计；可输出 JSON 诊断\n"
                 "  lsp                                     在标准输入输出上运行语言服务器\n"
                 "route 选项：\n"
                 "  --json                 输出 JSON（供插件 / 查看器消费）\n"
                 "  --time HH:mm           按某时刻查发车间隔与拥挤度（缺省为当前时间）\n"
                 "  --fewer-transfers      优先少换乘\n"
                 "  --no-special           不乘坐特殊线路（机场线 / 磁悬浮等）\n"
                 "  --matrix A B [C ...]   通勤矩阵：这几个站两两之间的耗时\n"
                 "game 选项：\n"
                 "  --json                 只导出游戏数据集（metro-game-1）\n"
                 "  --title \"…\"            页面标题（缺省为「<主城市> 地铁调度」）\n"
                 "coords 选项：--json  输出 JSON\n"
                 "其它：-q 安静；-h 帮助\n";
}

/** @brief 把 `HH:mm` 解析成 unix 秒（按本地今天的日期）。 */
std::int64_t parseClock(const std::string &text) {
    int hh = 0, mm = 0;
    if (std::sscanf(text.c_str(), "%d:%d", &hh, &mm) != 2) return 0;
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return 0;

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
    return static_cast<std::int64_t>(std::mktime(&local));
}

/** @brief 秒数格式化成 `1 小时 23 分`。 */
std::string formatDuration(double seconds) {
    const long total = static_cast<long>(seconds + 0.5);
    const long h = total / 3600;
    const long m = (total % 3600) / 60;
    const long s = total % 60;
    std::ostringstream ss;
    if (h > 0) ss << h << " 小时 ";
    if (h > 0 || m > 0) ss << m << " 分 ";
    ss << s << " 秒";
    return ss.str();
}

/** @brief 打印一次行程（对齐 metro_editor RouteDetailWindow 的呈现）。 */
void printRoute(const metro::RouteResult &r) {
    std::cout << r.from << " → " << r.to << "\n";
    for (std::size_t i = 0; i < r.segments.size(); ++i) {
        const metro::RouteSegment &s = r.segments[i];
        std::cout << "  " << (i + 1) << ". " << s.lineName;
        if (!s.towards.empty()) std::cout << "（开往 " << s.towards << "）";
        std::cout << "\n     " << s.from << " → " << s.to << "，" << s.stations << " 站 / "
                  << s.distanceKm << " km / " << formatDuration(s.runSeconds);
        if (s.outStationTransfer) std::cout << "（出站换乘）";
        std::cout << "\n";
    }
    std::cout << "合计：" << r.distanceKm << " km，换乘 " << r.transfers << " 次，" << r.stops
              << " 站\n"
              << "      乘车 " << formatDuration(r.runSeconds) << " + 换乘步行 "
              << formatDuration(r.transferWalkSeconds) << " + 候车 "
              << formatDuration(r.waitSeconds) << " + 进出站 "
              << formatDuration(r.entrySeconds) << "\n"
              << "      总计 " << formatDuration(r.totalSeconds) << "（按 " << r.clock
              << " 的发车间隔）\n"
              << "票价：" << r.fare << " 元";
    if (!r.fareNote.empty()) std::cout << "（" << r.fareNote << "）";
    std::cout << "\n";
}

/** @brief 打印坐标校正结果。 */
void printCoordFixes(const std::vector<metro::CoordFix> &fixes) {
    std::size_t changed = 0, suspicious = 0;
    for (const metro::CoordFix &f : fixes) {
        if (!f.hasOld) {
            ++suspicious;
            std::cout << "  [缺] " << f.name << "  " << f.reason << "\n";
            continue;
        }
        if (f.suspicious) {
            ++suspicious;
            std::cout << "  [疑] " << f.name << "  位移 " << f.shiftMeters << " m  " << f.reason << "\n";
            continue;
        }
        if (f.shiftMeters >= 1.0) {
            ++changed;
            std::cout << "  [改] " << f.name << "  " << f.oldLon << "," << f.oldLat << " → "
                      << f.newLon << "," << f.newLat << "  位移 " << f.shiftMeters << " m\n";
        }
    }
    std::cout << "小结：" << fixes.size() << " 座站，需转换 " << changed << " 座，需人工确认 "
              << suspicious << " 座\n";
}

} // namespace

int main(int argc, char **argv) {
    std::vector<std::string> args;
#if defined(_WIN32)
    // Windows 传进来的 argv 是按 ANSI 代码页（简体中文机器上是 CP936）解码的，
    // UTF-8 源码里的站名一进参数就成乱码。这里直接拿宽字符命令行，再转成 UTF-8，
    // 与内部（源码 / JSON 都是 UTF-8）保持一致。
    if (wchar_t **wargv = CommandLineToArgvW(GetCommandLineW(), &argc); wargv != nullptr) {
        for (int i = 0; i < argc; ++i) {
            const int need = WideCharToMultiByte(CP_UTF8, 0, wargv[i], -1, nullptr, 0, nullptr, nullptr);
            std::string s(need > 0 ? need - 1 : 0, '\0');
            if (need > 1) WideCharToMultiByte(CP_UTF8, 0, wargv[i], -1, s.data(), need, nullptr, nullptr);
            args.push_back(std::move(s));
        }
        LocalFree(wargv);
        args.erase(args.begin()); // 去掉程序名，与下面 argv + 1 对齐
    } else {
        args.assign(argv + 1, argv + argc);
    }
    // 控制台按 UTF-8 输出：否则中文站名、行程指引都会变成问号。
    SetConsoleOutputCP(CP_UTF8);
#else
    args.assign(argv + 1, argv + argc);
#endif
    if (args.empty() || args[0] == "-h" || args[0] == "--help") { usage(); return args.empty() ? 1 : 0; }

    const std::string command = args[0];
    std::string file, out, from, to, clock, coordFrom = "auto", title;
    bool fewer = false, quiet = false, diagnosticsJson = false, json = false, noSpecial = false;
    std::vector<std::string> matrix;
    for (std::size_t i = 1; i < args.size(); ++i) {
        const std::string &a = args[i];
        if ((a == "-o" || a == "--out") && i + 1 < args.size()) out = args[++i];
        else if (a == "--from" && i + 1 < args.size()) from = args[++i];
        else if (a == "--to" && i + 1 < args.size()) to = args[++i];
        else if (a == "--time" && i + 1 < args.size()) clock = args[++i];
        else if (a == "--title" && i + 1 < args.size()) title = args[++i];
        else if (a == "--from-coord" && i + 1 < args.size()) coordFrom = args[++i];
        else if (a.rfind("--from-coord=", 0) == 0) coordFrom = a.substr(13);
        else if (a == "--matrix" && i + 1 < args.size()) {
            while (i + 1 < args.size() && args[i + 1].rfind("--", 0) != 0) matrix.push_back(args[++i]);
        } else if (a == "--fewer-transfers") fewer = true;
        else if (a == "--no-special") noSpecial = true;
        else if (a == "--json") json = true;
        else if (a == "-q" || a == "--quiet") quiet = true;
        else if (a == "--diagnostics=json") diagnosticsJson = true;
        else if (!a.empty() && a[0] == '-') { std::cerr << "未知选项：" << a << "\n"; return 2; }
        else if (file.empty()) file = a;
        else { std::cerr << "多余参数：" << a << "\n"; return 2; }
    }
    if (file.empty() && command != "help" && command != "lsp") { usage(); return 2; }

    // 内嵌语言服务器：`lsp`（stdio）与 `check --diagnostics=json` 都在这条分支。
    if (command == "lsp" || (command == "check" && diagnosticsJson))
        return metro::runLspCommand({}, diagnosticsJson, file);

    if (command == "compile" || command == "decompile" || command == "html" || command == "game" ||
        command == "route" || command == "coords" || command == "check") {
        metro::Program program;
        std::vector<std::string> errors;
        if (command == "decompile") {
            std::string text;
            if (!readFile(file, text)) { std::cerr << "打不开文件：" << file << "\n"; return 1; }
            if (!metro::fromJson(text, program, errors)) {
                for (const std::string &e : errors) std::cerr << e << "\n";
                return 1;
            }
        } else if (!metro::compileFile(file, program, errors)) {
            for (const std::string &e : errors) std::cerr << e << "\n";
            return 1;
        }

        if (command == "compile") {
            const std::string text = metro::toJson(program);
            if (out.empty()) std::cout << text;
            else if (!writeFile(out, text)) { std::cerr << "写不了文件：" << out << "\n"; return 1; }
        } else if (command == "decompile") {
            const std::string text = metro::decompile(program);
            if (out.empty()) std::cout << text;
            else if (!writeFile(out, text)) { std::cerr << "写不了文件：" << out << "\n"; return 1; }
        } else if (command == "html") {
            const std::string text = metro::toHtml(program);
            if (out.empty()) std::cout << text;
            else if (!writeFile(out, text)) { std::cerr << "写不了文件：" << out << "\n"; return 1; }
        } else if (command == "game") {
            if (metro::writeGame(program, json, out, title) == metro::GameOutput::Failed) {
                std::cerr << "写不了文件：" << out << "\n";
                return 1;
            }
            if (!quiet && !out.empty()) {
                // 报数据集里的口径，不是模型全量：模型里还有只在规划段出现的站，
                // 玩家到不了；两个数不一致会让人以为漏站了。
                metro::GameStats gs = metro::gameStats(program);
                std::cerr << "已生成游戏：" << out << "（" << gs.lines << " 条线路，"
                          << gs.stationsOperating << " 座车站";
                if (gs.futureSegments)
                    std::cerr << "，" << gs.futureSegments / 2 << " 段在建";
                std::cerr << "）\n";
            }
        } else if (command == "route") {
            metro::RouteOptions options;
            options.preferFewerTransfers = fewer;
            options.excludeSpecial = noSpecial;
            if (!clock.empty()) options.timestamp = parseClock(clock);

            // 通勤矩阵：只算秒数，两两一行。用于"哪两站之间最远"这类检查。
            if (!matrix.empty()) {
                for (std::size_t i = 0; i < matrix.size(); ++i) {
                    for (std::size_t j = i + 1; j < matrix.size(); ++j) {
                        double seconds = 0.0;
                        if (!metro::shortestSeconds(program, matrix[i], matrix[j], options, seconds)) {
                            std::cerr << "找不到路径：" << matrix[i] << " → " << matrix[j] << "\n";
                            continue;
                        }
                        std::cout << matrix[i] << "\t" << matrix[j] << "\t"
                                  << static_cast<long>(seconds + 0.5) << "\n";
                    }
                }
                return 0;
            }

            if (from.empty() || to.empty()) { std::cerr << "需要 --from 与 --to\n"; return 2; }
            const metro::RouteResult result = metro::planRoute(program, from, to, options);
            if (!result.found) { std::cerr << result.error << "\n"; return 1; }
            if (json) std::cout << metro::toJson(result);
            else printRoute(result);
        } else if (command == "coords") {
            const std::vector<metro::CoordFix> fixes = metro::correctCoordinates(program, coordFrom);
            if (json) {
                std::cout << "[\n";
                for (std::size_t i = 0; i < fixes.size(); ++i) {
                    const metro::CoordFix &f = fixes[i];
                    std::cout << "  {\"name\":" << quote(f.name)
                              << ",\"hasOld\":" << (f.hasOld ? "true" : "false")
                              << ",\"oldLon\":" << f.oldLon << ",\"oldLat\":" << f.oldLat
                              << ",\"newLon\":" << f.newLon << ",\"newLat\":" << f.newLat
                              << ",\"shift\":" << f.shiftMeters
                              << ",\"suspicious\":" << (f.suspicious ? "true" : "false")
                              << ",\"reason\":" << quote(f.reason) << "}"
                              << (i + 1 == fixes.size() ? "\n" : ",\n");
                }
                std::cout << "]\n";
            } else {
                printCoordFixes(fixes);
            }
        } else if (command == "check") {
            std::size_t directions = 0;
            for (const metro::Line &l : program.lines) directions += l.directions.size();
            std::cout << "OK：" << program.lines.size() << " 条线路，" << program.stations.size()
                      << " 座车站，" << program.transfers.size() << " 条换乘，"
                      << directions << " 个方向，未建模块 " << program.raw.size() << " 行\n";
            if (!quiet) {
                if (!program.keyCity.empty()) std::cout << "主城市：" << program.keyCity << "\n";
                std::cout << "运营规则：发车间隔 " << program.headways.size() << " 条线路，拥挤度 "
                          << program.crowds.size() << " 个方向，停站规则 " << program.dwellRules.size()
                          << " 条，限速 " << program.speedLimits.size() << " 条\n";
            }
        }
        return 0;
    }

    std::cerr << "未知命令：" << command << "\n";
    usage();
    return 2;
}
