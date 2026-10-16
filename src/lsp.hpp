/**
 * @file lsp.hpp
 * @brief `metro-lang` 内嵌语言服务器的入口声明。
 */
#pragma once

#include <string>
#include <vector>

namespace metro {

/**
 * @brief 运行内嵌语言服务器的命令入口（由 main.cpp 派发）。
 *
 * - `metro-lang lsp`：在标准输入输出上跑 LSP；
 * - `metro-lang check FILE --diagnostics=json`：输出稳定的 JSON 诊断。
 *
 * @param args `lsp` / `check` 之后的剩余参数（当前未使用）。
 * @param diagnosticsJson check 命令是否带了 --diagnostics=json。
 * @param file check 命令的文件路径。
 * @return 进程退出码。
 */
int runLspCommand(const std::vector<std::string> &args, bool diagnosticsJson,
                  const std::string &file);

} // namespace metro
