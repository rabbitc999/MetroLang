/**
 * @file compile.cpp
 * @brief 编译入口：library/preprocess 预处理 + %IMPORT CSV -> 生成的分析器。
 *
 * 真正的解析流程（驱动 Parser::Engine、块栈折叠）在 metrolang.gram 的
 * %epilogue 里，随生成产物内嵌；本文件只做预处理与 CSV 导入。
 */
#include "metro_model.hpp"

#include "preprocess.hpp"

#include <cctype>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

namespace metro {
namespace {

/** @brief 去掉 UTF-8 BOM。 */
std::string stripBom(std::string s) {
    if (s.size() >= 3 && static_cast<unsigned char>(s[0]) == 0xEF &&
        static_cast<unsigned char>(s[1]) == 0xBB && static_cast<unsigned char>(s[2]) == 0xBF)
        s.erase(0, 3);
    return s;
}

/** @brief 拆分一行 CSV（支持双引号转义）。 */
std::vector<std::string> splitCsv(const std::string &line) {
    std::vector<std::string> out;
    std::string cur;
    bool quoted = false;
    for (std::size_t i = 0; i < line.size(); ++i) {
        char c = line[i];
        if (quoted) {
            if (c == '"' && i + 1 < line.size() && line[i + 1] == '"') { cur.push_back('"'); ++i; }
            else if (c == '"') quoted = false;
            else cur.push_back(c);
        } else if (c == '"') quoted = true;
        else if (c == ',') { out.push_back(cur); cur.clear(); }
        else if (c != '\r') cur.push_back(c);
    }
    out.push_back(cur);
    return out;
}

/** @brief 去首尾空白。 */
std::string trim(const std::string &s) {
    std::size_t a = s.find_first_not_of(" \t\r\n");
    if (a == std::string::npos) return "";
    std::size_t b = s.find_last_not_of(" \t\r\n");
    return s.substr(a, b - a + 1);
}

/** @brief 文本是否是数字。 */
bool isNumber(const std::string &s) {
    if (s.empty()) return false;
    std::size_t a = (s[0] == '-' || s[0] == '+') ? 1 : 0;
    bool digit = false, dot = false;
    for (std::size_t i = a; i < s.size(); ++i) {
        if (s[i] >= '0' && s[i] <= '9') digit = true;
        else if (s[i] == '.' && !dot) dot = true;
        else return false;
    }
    return digit;
}

/** @brief 把 %IMPORT 的 CSV 转成 STATION_DEFINE 块。 */
std::string csvToStations(const std::string &text) {    std::istringstream in(stripBom(text));
    std::string line, out = "STATION_DEFINE\n";
    std::vector<std::string> head;
    int iName = 0, iLon = 1, iLat = 2, iCity = 3;
    bool first = true;
    while (std::getline(in, line)) {
        if (trim(line).empty()) continue;
        std::vector<std::string> cells = splitCsv(line);
        if (first) {
            first = false;
            head = cells;
            for (std::size_t i = 0; i < head.size(); ++i) {
                std::string h = trim(head[i]);
                if (h == "站名" || h == "name" || h == "NAME") iName = static_cast<int>(i);
                else if (h == "经度" || h == "lon" || h == "LON") iLon = static_cast<int>(i);
                else if (h == "纬度" || h == "lat" || h == "LAT") iLat = static_cast<int>(i);
                else if (h == "城市" || h == "city" || h == "CITY") iCity = static_cast<int>(i);
            }
            continue;
        }
        const std::size_t n = cells.size();
        std::string name = n > static_cast<std::size_t>(iName) ? trim(cells[iName]) : "";
        std::string lon = n > static_cast<std::size_t>(iLon) ? trim(cells[iLon]) : "";
        std::string lat = n > static_cast<std::size_t>(iLat) ? trim(cells[iLat]) : "";
        std::string city = n > static_cast<std::size_t>(iCity) ? trim(cells[iCity]) : "";
        if (name.empty() || !isNumber(lon) || !isNumber(lat)) continue;
        out += "NODE '" + name + "' COORD " + lon + ", " + lat +
               (city.empty() ? "" : " CITY '" + city + "'") + "\n";
    }
    out += "END_DEFINE\n";
    return out;
}

} // namespace

std::string csvToStationBlock(const std::string &csvText) { return csvToStations(csvText); }

bool compileFile(const std::string &path, Program &out, std::vector<std::string> &errors,
                 std::vector<std::string> *deps) {
    preprocess::Options options = preprocess::Preprocessor::forMetro();
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
        return preprocess::IncludeResult::inlineText(csvToStations(ss.str()), request.resolvedPath);
    };

    preprocess::Preprocessor preprocessor(options);
    preprocess::Result result;
    if (!preprocessor.runFile(path, result)) {
        for (const preprocess::Diagnostic &d : result.diagnostics) errors.push_back(d.toString());
        if (errors.empty()) errors.push_back("预处理失败：" + path);
        return false;
    }
    if (deps != nullptr) *deps = result.dependencies;
    return compileText(result.text, out, errors);
}

} // namespace metro
