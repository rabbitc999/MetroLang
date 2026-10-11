/**
 * @file main.cpp
 * @brief `metro-lang` 命令行：compile / decompile / html / route / check。
 */
#include "metro_model.hpp"

#include <cstdio>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace {

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
                 "  route <file.metro> --from A --to B      查询最短时间路径\n"
                 "  check <file.metro>                      解析并打印统计\n"
                 "选项：--fewer-transfers  查询时优先少换乘；-q 安静；-h 帮助\n";
}

} // namespace

int main(int argc, char **argv) {
    std::vector<std::string> args(argv + 1, argv + argc);
    if (args.empty() || args[0] == "-h" || args[0] == "--help") { usage(); return args.empty() ? 1 : 0; }

    const std::string command = args[0];
    std::string file, out, from, to;
    bool fewer = false, quiet = false;
    for (std::size_t i = 1; i < args.size(); ++i) {
        const std::string &a = args[i];
        if ((a == "-o" || a == "--out") && i + 1 < args.size()) out = args[++i];
        else if (a == "--from" && i + 1 < args.size()) from = args[++i];
        else if (a == "--to" && i + 1 < args.size()) to = args[++i];
        else if (a == "--fewer-transfers") fewer = true;
        else if (a == "-q" || a == "--quiet") quiet = true;
        else if (!a.empty() && a[0] == '-') { std::cerr << "未知选项：" << a << "\n"; return 2; }
        else if (file.empty()) file = a;
        else { std::cerr << "多余参数：" << a << "\n"; return 2; }
    }
    if (file.empty() && command != "help") { usage(); return 2; }

    if (command == "compile" || command == "decompile" || command == "html" ||
        command == "route" || command == "check") {
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
        } else if (command == "route") {
            metro::RouteOptions options;
            options.preferFewerTransfers = fewer;
            std::string error;
            const std::string text = metro::queryRoute(program, from, to, options, error);
            if (!error.empty()) { std::cerr << error << "\n"; return 1; }
            std::cout << text;
        } else if (command == "check") {
            std::size_t directions = 0;
            for (const metro::Line &l : program.lines) directions += l.directions.size();
            std::cout << "OK：" << program.lines.size() << " 条线路，" << program.stations.size()
                      << " 座车站，" << program.transfers.size() << " 条换乘，"
                      << directions << " 个方向，未建模块 " << program.raw.size() << " 行\n";
            if (!quiet && !program.keyCity.empty()) std::cout << "主城市：" << program.keyCity << "\n";
        }
        return 0;
    }

    std::cerr << "未知命令：" << command << "\n";
    usage();
    return 2;
}
