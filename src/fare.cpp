/**
 * @file fare.cpp
 * @brief 票价：口径对齐 metro_editor 的 SimFareCalculator。
 *
 * 规则很简单，但有两个容易写错的地方，这里按 C# 版原样保留：
 *   1. 普通区段是**合并后按总里程**结算（不是每段单独算再相加）；
 *   2. 特殊线路（`SPECIAL_LINE`）要么整条一口价（`ALL`），要么有自己的区间表，
 *      与普通区段分开结算。
 */
#include "metro_model.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

namespace metro {
namespace {

/** @brief 保留两位小数（票价不显示 2.9999999）。 */
double round2(double v) { return std::round(v * 100.0) / 100.0; }

/** @brief 数字 -> 文本，去掉多余的 0。 */
std::string numText(double v) {
    char buffer[32];
    std::snprintf(buffer, sizeof(buffer), "%.2f", v);
    std::string text = buffer;
    while (text.size() > 1 && text.back() == '0') text.pop_back();
    if (!text.empty() && text.back() == '.') text.pop_back();
    return text;
}

/** @brief 阶梯表命中（左闭右开）；没命中返回 false。 */
bool hitSegment(const std::vector<PriceSegment> &segments, double km, double &outFare) {
    for (const PriceSegment &s : segments) {
        if (km >= s.lo && km < s.hi) { outFare = s.fare; return true; }
    }
    return false;
}

/** @brief 普通票价：阶梯区间 -> 线性延伸 -> 起步价。 */
double baseFare(const Program &p, double km) {
    if (km <= 0.0) return 0.0;
    double fare = 0.0;
    if (hitSegment(p.segments, km, fare)) return fare;
    if (p.linearExtension.present && km >= p.linearExtension.threshold)
        return p.linearExtension.base + (km - p.linearExtension.threshold) * p.linearExtension.rate;
    return p.defaultFare;
}

/** @brief 找某条线路的特殊票价规则；没有返回 nullptr。 */
const SpecialLineFare *findSpecial(const Program &p, const std::string &lineId) {
    for (const SpecialLineFare &rule : p.specialLines)
        if (rule.lineId == lineId) return &rule;
    return nullptr;
}

/** @brief 特殊线路自己的里程票价（区间表，超出最大区间时沿用最高档）。 */
double specialFareByKm(const SpecialLineFare &rule, double km) {
    if (km <= 0.0) return 0.0;
    if (!rule.segments.empty()) {
        double fare = 0.0;
        if (hitSegment(rule.segments, km, fare)) return fare;
        double best = 0.0;
        for (const PriceSegment &s : rule.segments) best = std::max(best, s.fare);
        return best;
    }
    return rule.hasDefaultFare ? rule.defaultFare : rule.fare;
}

/** @brief 一句话说明票价是怎么来的。 */
std::string fareNoteFor(const Program &p, const std::string &currency) {
    std::string note;
    if (!p.segments.empty()) {
        note = "按里程阶梯计价（" + std::to_string(p.segments.size()) + " 档";
        if (p.linearExtension.present)
            note += "，超过 " + numText(p.linearExtension.threshold) + " km 每公里 " +
                    numText(p.linearExtension.rate) + " 元";
        note += "）";
    } else if (p.linearExtension.present) {
        note = "线性计价：超过 " + numText(p.linearExtension.threshold) + " km 每公里 " +
               numText(p.linearExtension.rate) + " 元";
    } else if (p.defaultFare > 0.0) {
        note = "单一票价";
    } else {
        note = "数据里没有票价规则，按 0 元计";
    }
    if (!currency.empty() && currency != "CNY") note += "，货币 " + currency;
    if (p.fareCap > 0.0) note += "，封顶 " + numText(p.fareCap) + " 元";
    return note;
}

} // namespace

double computeFare(const Program &p, const std::vector<RouteSegment> &segments, double &outSpecial,
                   std::string &outNote) {
    outSpecial = 0.0;
    outNote = fareNoteFor(p, p.currency);
    if (segments.empty()) { outNote = "无需乘车"; return 0.0; }

    // 普通段合并里程，特殊段各自结算 —— 与 SimFareCalculator.CalculateFareDetails 一致。
    double normalKm = 0.0;
    double specialTotal = 0.0;
    std::string specialNote;
    for (const RouteSegment &segment : segments) {
        const SpecialLineFare *rule = findSpecial(p, segment.lineId);
        if (rule == nullptr) { normalKm += segment.distanceKm; continue; }
        if (rule->all) {
            specialTotal += rule->fare;
            specialNote = segment.lineName + " 一口价 " + numText(rule->fare) + " 元";
            continue;
        }
        if (rule->hasDefaultFare || !rule->segments.empty()) {
            const double fare = specialFareByKm(*rule, segment.distanceKm);
            specialTotal += fare;
            specialNote = segment.lineName + " 单独计价 " + numText(fare) + " 元";
            continue;
        }
        // 只写了区段附加费的规则：落在附加费区段里就加钱，否则并进普通里程。
        const bool inSegment = !rule->from.empty() && !rule->to.empty() &&
                               ((segment.from == rule->from && segment.to == rule->to) ||
                                (segment.from == rule->to && segment.to == rule->from));
        if (inSegment) {
            specialTotal += rule->fare;
            specialNote = segment.lineName + " 区段附加 " + numText(rule->fare) + " 元";
        } else {
            normalKm += segment.distanceKm;
        }
    }

    double total = baseFare(p, normalKm) + specialTotal;
    if (p.fareCap > 0.0) total = std::min(total, p.fareCap);
    outSpecial = round2(specialTotal);
    if (!specialNote.empty()) outNote += "；" + specialNote;
    if (normalKm > 0.0) outNote += "；普通里程 " + numText(normalKm) + " km";
    return round2(total);
}

} // namespace metro
