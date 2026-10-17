/**
 * @file metro_semantics.hpp
 * @brief 文法语义动作接口（供 metrolang.gram 的 %code / 产生式调用）。
 *
 * 解析流程分两层，且都随解析器生成器内嵌：
 *   - 词法/语法：`metrolang.gram` 生成；
 *   - 语义：`%code` / `%epilogue` 里的本模块，按「当前块 + 行首关键字」
 *     把每一行折叠进 `metro::Program`。
 *
 * 产生式只调用这里的 `mb_*`：`mb_begin` 开块、`mb_line` 填一行、
 * `mb_modify` 处理 SET/ADD/REMOVE、`mb_end_block` 关块。
 */
#pragma once

#include <string>
#include <string_view>
#include <vector>

#include "metro_model.hpp"

namespace metro {

/** @brief 块种类：语义层据此决定成员行如何折叠。 */
enum BlockKind {
    MB_PROGRAM,            ///< PROGRAM_DEFINE
    MB_STATION,            ///< STATION_DEFINE
    MB_STATION_MODIFY,     ///< STATION_MODIFY
    MB_OPERATION,          ///< OPERATION_DEFINE
    MB_PRICE,              ///< PRICE_DEFINE
    MB_LABEL_DEFINE,       ///< LABEL_DEFINE
    MB_FACILITY_DEFINE,    ///< FACILITY_DEFINE
    MB_PROMOTION_DEFINE,   ///< PROMOTION_DEFINE
    MB_ZONE_DEFINE,        ///< ZONE_DEFINE
    MB_OPERATOR_DEFINE,    ///< OPERATOR_DEFINE
    MB_BACKGROUND_DEFINE,  ///< BACKGROUND_DEFINE
    MB_SPECIAL_DEFINE,     ///< SPECIAL_DEFINE
    MB_ATTRIBUTES,         ///< ATTRIBUTES … END_ATTRIBUTES
    MB_POLICY,             ///< POLICY … END_POLICY
    MB_TRANSFER_TYPE,      ///< TRANSFER_TYPE
    MB_TRANSFER_DEFINE,    ///< TRANSFER_DEFINE
    MB_VIRTUAL_TRANSFER,   ///< VIRTUAL_TRANSFER_DEFINE
    MB_HEADWAY_PROFILE,    ///< HEADWAY_PROFILE
    MB_CROWD_PROFILE,      ///< CROWD_PROFILE
    MB_DWELL_DEFINE,       ///< DWELL_TIME_DEFINE
    MB_SPEED_LIMIT_DEFINE, ///< SPEED_LIMIT_DEFINE
    MB_LINE_TEMPLATE,      ///< LINE_TEMPLATE
    MB_DIRECTION_TEMPLATE, ///< DIRECTION_TEMPLATE
    MB_LINE,               ///< LINE_DEFINE
    MB_DIRECTION,          ///< DIRECTION_DEFINE
    MB_LINE_MODIFY,        ///< LINE_MODIFY
    MB_DIRECTION_MODIFY    ///< DIRECTION_MODIFY
};

/**
 * @brief 词法单元 -> 语义值句柄。
 * @param kind 1 = 数字，2 = 字符串，3 = 标识符 / 关键字 / 标点。
 * @param text 词素原文。
 * @param value 数字值（kind == 1 时有效）。
 * @return 值表句柄。
 */
int mb_token_value(int kind, std::string_view text, double value);

/** @brief 追加一个参数（产生式在参数 / 列表元素处调用）。 @param value 值表句柄。 */
void mb_arg(int value);

/** @brief 结束一行：按当前块和行首关键字折叠进模型。 @param head 行首关键字句柄。 */
void mb_line(int head);

/** @brief 开一个块，并消费块头已收集的参数。 @param kind 块种类。 */
void mb_begin(BlockKind kind);

/** @brief 关闭当前块（END_DEFINE）。 */
void mb_end_block();

/** @brief 关闭 POLICY 子块（END_POLICY）。 */
void mb_end_policy();

/** @brief 关闭 ATTRIBUTES 子块（END_ATTRIBUTES）。 */
void mb_end_attributes();

/**
 * @brief 处理 SET / ADD / REMOVE 动词行。
 * @param verb 动词句柄（SET / ADD / REMOVE）。
 * @param attr 属性句柄。
 */
void mb_modify(int verb, int attr);

/** @brief 取解析出的模型（编译成功时有效）。 @return 模型引用。 */
Program &mb_program();

/** @brief 取语义层诊断。 @return 诊断列表。 */
const std::vector<std::string> &mb_errors();

} // namespace metro
