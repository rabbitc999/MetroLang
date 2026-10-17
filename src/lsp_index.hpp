/**
 * @file lsp_index.hpp
 * @brief 语言服务器的源码语义索引（hover / definition / documentSymbol 用）。
 *
 * 索引把「源码文本」与「编译后的模型」对齐：模型回答"这个标识符是什么"，
 * 源码回答"它写在哪一行哪一列"。每次编译后重建一次，成本与文件大小线性相关。
 */
#pragma once

#include "metro_model.hpp"

#include <cstddef>
#include <string>
#include <vector>

namespace metro {

/** @brief 一个标识符在源码里的定义位置与展示信息。 */
struct IndexEntry {
    std::string kind;       ///< `line` / `station` / `direction` / `operation` / `transfer_type`。
    std::string name;       ///< 标识符本身（线路 ID、站名、方向 ID、关键字）。
    std::string signature;  ///< 一行签名（hover 顶部代码块）。
    std::string doc;        ///< markdown 说明（hover 正文）。
    int line = 0;           ///< 定义所在行（0 起算）。
    std::size_t column = 0; ///< 起始字节列。
    std::size_t length = 0; ///< 标识符字节长度。
    bool declaration = false; ///< true = 定义处；false = 引用处。
};

/** @brief 源码里的一行词素。 */
struct IndexToken {
    std::string text;       ///< 词素文本（字符串已去引号）。
    std::size_t begin = 0;  ///< 起始字节。
    std::size_t end = 0;    ///< 结束字节（不含）。
    bool quoted = false;    ///< 是否是引号串。
};

/** @brief 源码语义索引。 */
class SourceIndex {
public:
    /**
     * @brief 用模型 + 源码重建索引。
     * @param program 编译好的模型（索引不持有它，调用期间必须有效）。
     * @param text 源码全文。
     */
    void build(const Program &program, const std::string &text);

    /**
     * @brief 把光标位置解析成一条索引记录。
     * @param line 行号（0 起算）。
     * @param column 列号（字节）。
     * @return 记录指针（指向内部存储）；没命中返回 nullptr。
     */
    const IndexEntry *lookup(int line, std::size_t column) const;

    /**
     * @brief 名为 name 的所有**定义**（不含引用）。
     * @param name 标识符。
     * @return 记录指针列表。
     */
    std::vector<const IndexEntry *> definitionsOf(const std::string &name) const;

    /** @brief 所有记录（含引用），按行号排序。 */
    const std::vector<IndexEntry> &entries() const { return entries_; }

    /**
     * @brief 某行的词素表（空行返回空表）。
     * @param line 行号。
     * @return 词素引用。
     */
    const std::vector<IndexToken> &tokens(int line) const;

    /**
     * @brief 某行是否是空行或纯注释行。
     * @param line 行号。
     * @return 是则 true。
     */
    bool blankLine(int line) const;

    /** @brief 源码行数。 */
    int lineCount() const { return static_cast<int>(lines_.size()); }

private:
    void indexLine(const Program &program, int line, const std::vector<IndexToken> &tokens);
    void addDefinition(IndexEntry entry) { entries_.push_back(std::move(entry)); }

    std::vector<IndexEntry> entries_;
    std::vector<std::string> lines_;
    std::vector<std::vector<IndexToken>> tokensByLine_;
};

} // namespace metro
