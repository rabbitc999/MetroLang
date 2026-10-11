#!/usr/bin/env python3
"""把 template/templates/*.tmpl 固化进 C++ 头文件（构建期调用）。

用法：
    python3 tools/embed_templates.py --out build/gen/metro_templates.hpp template/templates/*.tmpl
"""
import argparse
import os
import sys

HEADER = '''/**
 * @file metro_templates.hpp
 * @brief 由 tools/embed_templates.py 生成的模板固化头（请勿手改）。
 *
 * 把 template/templates/ 下的 .tmpl 模板以原始字符串内嵌进程序，运行时不依赖磁盘模板，
 * 单文件产物也能反编译。
 */
#pragma once

#include <map>
#include <string>

namespace metro {
namespace templates {

'''

FOOTER = '''
/** @brief 片段表：名字 -> 模板正文（供 {% include "名字" %} 使用）。 */
inline const std::map<std::string, std::string> &snippets() {
    static const std::map<std::string, std::string> table = {
__PAIRS__
    };
    return table;
}

} // namespace templates
} // namespace metro
'''


def ident(name):
    out = ''.join(c if c.isalnum() else '_' for c in name)
    return 'k_' + out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('files', nargs='+')
    args = ap.parse_args()

    chunks = []
    pairs = []
    for path in sorted(args.files):
        base = os.path.splitext(os.path.basename(path))[0]
        text = open(path, encoding='utf-8').read()
        if ')METROTMPL"' in text:
            sys.exit('模板里出现了哨兵 )METROTMPL"：' + path)
        chunks.append('inline constexpr const char *%s = R"METROTMPL(%s)METROTMPL";\n'
                      % (ident(base), text))
        if base != 'decompile':
            pairs.append('        {"%s", %s},' % (base, ident(base)))

    body = HEADER + '\n'.join(chunks) + FOOTER.replace('__PAIRS__', '\n'.join(pairs))
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    open(args.out, 'w', encoding='utf-8').write(body)
    print('嵌入 %d 份模板 -> %s' % (len(chunks), args.out))


if __name__ == '__main__':
    main()
