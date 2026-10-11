/**
 * @file decompile.cpp
 * @brief 反编译器：模型 -> MetroLang 源码（library/template 模板化生成）。
 *
 * 输出格式全部在 template/templates/ 下的 .tmpl 模板里（构建期固化进 metro_templates.hpp），
 * 本文件只把模型整理成模板要的数据：数值 / 字符串 / 预拼好的行片段。
 */
#include "metro_model.hpp"

#include "metro_templates.hpp"
#include "template/engine.hpp"

#include <cctype>
#include <cmath>
#include <memory>
#include <cstdio>
#include <string>
#include <vector>

namespace metro {
namespace {

using tmpl::Array;
using tmpl::Object;
using tmpl::Value;

/** @brief 数字文本：整数不带小数点，浮点保留足够精度（坐标 6 位小数能原样往返）。 */
std::string numStr(double v) {
    char buf[64];
    if (std::fabs(v - std::llround(v)) < 1e-9)
        std::snprintf(buf, sizeof(buf), "%lld", static_cast<long long>(std::llround(v)));
    else
        std::snprintf(buf, sizeof(buf), "%.10g", v);
    return buf;
}

/** @brief 单引号字符串字面量。 */
std::string quote(const std::string &s) {
    std::string out = "'";
    for (char c : s) {
        if (c == '\'' || c == '\\') out.push_back('\\');
        out.push_back(c);
    }
    out.push_back('\'');
    return out;
}

/** @brief `['a', 'b']` 形式的列表字面量。 */
std::string listLit(const std::vector<std::string> &items) {
    std::string out = "[";
    for (std::size_t i = 0; i < items.size(); ++i) {
        if (i) out += ", ";
        out += quote(items[i]);
    }
    out += "]";
    return out;
}

/** @brief 转大写（写 `GENDER MALE` 这类枚举值用）。 */
std::string upper(std::string v) {
    for (char &c : v) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    return v;
}

/**
 * @brief 把内联在站点上的无障碍设施还原成 `FACILITY_DEFINE` 块。
 *
 * JSON v2 把设施绑在站点对象里，反编译时再摊平成原来的一行式成员：
 * `TOILET '站名' POSITION PAID_AREA ACCESSIBLE GENDER MIXED` 等。没有设施
 * 的站点不产生任何行；整份数据没有设施就不产生这个块。
 */
std::string facilityBlock(const Program &p) {
    std::string body;
    for (const Station &s : p.stations) {
        const StationAccess &a = s.access;
        if (!a.present) continue;
        const std::string q = quote(s.name);
        if (a.hasToilet) {
            body += "    TOILET " + q + " POSITION " +
                    (a.toilet.position == "unpaid_area" ? "UNPAID_AREA" : "PAID_AREA");
            if (a.toilet.accessible) body += " ACCESSIBLE";
            if (!a.toilet.gender.empty() && a.toilet.gender != "mixed")
                body += " GENDER " + upper(a.toilet.gender);
            body += "\n";
        }
        if (a.hasAccessibleToilet) {
            body += "    ACCESSIBLE_TOILET " + q + " POSITION " +
                    (a.accessibleToilet.position == "unpaid_area" ? "UNPAID_AREA" : "PAID_AREA");
            if (!a.accessibleToilet.gender.empty() && a.accessibleToilet.gender != "mixed")
                body += " GENDER " + upper(a.accessibleToilet.gender);
            body += "\n";
        }
        for (const ElevatorInfo &e : a.elevators) {
            body += "    ELEVATOR " + q;
            if (!e.location.empty()) body += " LOCATION " + quote(e.location);
            if (e.accessible) body += " ACCESSIBLE";
            body += "\n";
        }
        if (a.hasWideGate)
            body += "    WIDE_GATE " + q + " QUANTITY " + numStr(a.wideGate.quantity) + "\n";
        for (const EscalatorInfo &e : a.escalators) {
            body += "    ESCALATOR " + q + " QUANTITY " + numStr(e.quantity);
            if (!e.direction.empty() && e.direction != "both")
                body += " DIRECTION " + upper(e.direction);
            body += "\n";
        }
        if (a.hasTactilePaving)
            body += "    TACTILE_PAVING " + q + " STATUS " + a.tactilePaving.status + "\n";
    }
    if (body.empty()) return "";
    return "FACILITY_DEFINE\n" + body + "END_DEFINE\n\n";
}

/**
 * @brief 方向的距离行：能写成 `DISTANCE AUTO` 就写 AUTO，否则列出显式值。
 *
 * 判据是「每个显式距离都等于按坐标算出来的球面距离」：源里本来就用 AUTO 的
 * 方向往返后还是 AUTO；源里给了显式距离（可能是更精确的实测值）时保留原值，
 * 不会被几何估算覆盖。
 */
std::string distanceLine(const Program &p, const Direction &d) {
    const std::size_t n = d.stations.size();
    if (n < 2) return "";
    // 一般方向是 n-1 段距离；环线的末站还带一段"绕回起点"的距离，那时是 n 段。
    const std::size_t count = d.stations.back().hasNext ? n : n - 1;

    bool autoOk = true;
    bool anyDistance = false;
    for (std::size_t i = 0; i < count; ++i) {
        if (!d.stations[i].hasNext) { autoOk = false; continue; }
        anyDistance = true;
        const Station *a = p.findStation(d.stations[i].name);
        const Station *b = p.findStation(d.stations[(i + 1) % n].name);
        if (a == nullptr || b == nullptr || !a->hasCoord || !b->hasCoord) { autoOk = false; continue; }
        if (std::fabs(stationDistanceKm(*a, *b) - d.stations[i].next) > 1e-6) autoOk = false;
    }
    if (!anyDistance) return "";
    if (autoOk) return "DISTANCE AUTO";
    // 显式距离按位置写：缺距离的位置写 NIL，读回来才不会错位。
    std::string out = "DISTANCE [";
    for (std::size_t i = 0; i < count; ++i) {
        if (i) out += ", ";
        out += d.stations[i].hasNext ? numStr(d.stations[i].next) : std::string("NIL");
    }
    out += "]";
    return out;
}

} // namespace

std::string decompile(const Program &p) {
    auto root = std::make_shared<Object>();

    // 城市名按字符串字面量写出：中文地名不是合法标识符，裸写会读不回来。
    root->insert("keyCity", Value(quote(p.keyCity)));
    root->insert("otherCities", Value(listLit(p.otherCities)));
    root->insert("version", Value(quote(p.version)));
    root->insert("author", Value(quote(p.author)));
    // 空日期不写占位：`CREATE_DATE ''` 会变成一个空字符串字段，往返比对就不相等了。
    root->insert("createDate", Value(p.createDate.empty() ? std::string() : quote(p.createDate)));
    root->insert("updateDate", Value(p.updateDate.empty() ? std::string() : quote(p.updateDate)));

    auto op = std::make_shared<Object>();
    op->insert("transferTime", Value(p.transferTime));
    op->insert("outStationTransferTime", Value(p.outStationTransferTime));
    op->insert("dwellTime", Value(p.dwellTime));
    op->insert("entryTime", Value(p.entryTime));
    op->insert("avgBoardTime", Value(p.avgBoardTime));
    root->insert("operation", Value(op));

    auto types = std::make_shared<Array>();
    for (const TransferType &t : p.transferTypes) {
        auto o = std::make_shared<Object>();
        o->insert("id", Value(t.id));
        o->insert("name", Value(quote(t.name)));
        o->insert("time", Value(t.time));
        o->insert("timeLine", Value(t.time > 0));
        o->insert("status", Value(t.status));
        o->insert("statusLine", Value(!t.status.empty()));
        types->items.push_back(Value(o));
    }
    root->insert("transferTypes", Value(types));

    auto stations = std::make_shared<Array>();
    for (const Station &s : p.stations) {
        auto o = std::make_shared<Object>();
        o->insert("name", Value(quote(s.name)));
        std::string coord;
        if (s.hasCoord) coord = " COORD " + numStr(s.lon) + ", " + numStr(s.lat);
        o->insert("coordLine", Value(coord));
        o->insert("cityLine", Value(s.city.empty() ? "" : (" CITY " + quote(s.city))));
        std::string aliases;
        for (const std::string &a : s.otherNames) aliases += "    OTHER_NAME " + quote(a) + "\n";
        o->insert("otherNameLines", Value(aliases));
        stations->items.push_back(Value(o));
    }
    root->insert("stations", Value(stations));
    root->insert("facilityBlock", Value(facilityBlock(p)));

    auto lines = std::make_shared<Array>();
    for (const Line &l : p.lines) {
        auto o = std::make_shared<Object>();
        o->insert("id", Value(l.id));
        o->insert("name", Value(quote(l.name)));
        o->insert("color", Value(quote(l.color)));
        o->insert("city", Value(quote(l.city)));
        o->insert("cityLine", Value(!l.city.empty()));
        std::string formationLines;
        for (const std::string &f : l.formations)
            formationLines += "    FORMATION " + quote(f) + "\n";
        o->insert("formationLines", Value(formationLines));
        o->insert("maxspeed", Value(numStr(l.maxspeed)));
        o->insert("openYear", Value(l.openYear));
        o->insert("openYearLine", Value(l.openYear != 0));
        o->insert("power", Value(numStr(l.power)));
        o->insert("powerLine", Value(l.power != 0.0));
        o->insert("brake", Value(numStr(l.brake)));
        o->insert("brakeLine", Value(l.brake != 0.0));
        std::string linkLines;
        for (const std::string &u : l.links) linkLines += "    LINK " + quote(u) + "\n";
        o->insert("linkLines", Value(linkLines));
        o->insert("image", Value(quote(l.image)));
        o->insert("imageLine", Value(!l.image.empty()));
        o->insert("disabled", Value(l.disabled));
        o->insert("special", Value(l.special));
        o->insert("pending", Value(listLit(l.pending)));
        o->insert("pendingLine", Value(!l.pending.empty()));

        auto dirs = std::make_shared<Array>();
        for (const Direction &d : l.directions) {
            auto e = std::make_shared<Object>();
            e->insert("id", Value(d.id));
            e->insert("revSuffix", Value(d.revOf.empty() ? "" : (" REV " + d.revOf)));
            std::string names;
            for (std::size_t i = 0; i < d.stations.size(); ++i) {
                if (i) names += ", ";
                names += quote(d.stations[i].name);
            }
            e->insert("stations", Value("[" + names + "]"));
            e->insert("stationsLine", Value(!d.stations.empty()));
            e->insert("distanceLine", Value(distanceLine(p, d)));
            e->insert("dwell", Value(numStr(d.dwellTime)));
            e->insert("dwellLine", Value(d.dwellTime >= 0));
            e->insert("loop", Value(d.loop));
            e->insert("directionType", Value(d.directionType));
            e->insert("future", Value(d.isFuture));
            e->insert("connect", Value(quote(d.connectStation)));
            e->insert("connectLine", Value(!d.connectStation.empty()));
            e->insert("express", Value(listLit(d.expressStops)));
            e->insert("expressLine", Value(!d.expressStops.empty()));
            std::string routings;
            for (const Routing &r : d.routings)
                routings += "        ROUTING " + quote(r.name) + " " + listLit(r.stations) + "\n";
            e->insert("routings", Value(routings));
            dirs->items.push_back(Value(e));
        }
        o->insert("directions", Value(dirs));
        lines->items.push_back(Value(o));
    }
    root->insert("lines", Value(lines));

    auto transfers = std::make_shared<Array>();
    for (const Transfer &t : p.transfers) {
        auto o = std::make_shared<Object>();
        o->insert("type", Value(t.type));
        o->insert("typeLine", Value(!t.type.empty()));
        o->insert("station", Value(quote(t.station)));
        o->insert("lineA", Value(t.lineA));
        o->insert("lineB", Value(t.lineB));
        // 只有显式写了 TIME 才回写 TIME：否则读回来会多出一个 hasTime，
        // 与"沿用全局默认时间"的原意不一致。
        o->insert("time", Value(t.time));
        o->insert("timeLine", Value(t.hasTime));
        transfers->items.push_back(Value(o));
    }
    root->insert("transfers", Value(transfers));

    auto openTimes = std::make_shared<Array>();
    for (const OpenTime &t : p.openTimes) {
        auto o = std::make_shared<Object>();
        o->insert("id", Value(t.id));
        o->insert("from", Value(t.from));
        o->insert("to", Value(t.to));
        openTimes->items.push_back(Value(o));
    }
    root->insert("openTimes", Value(openTimes));

    auto price = std::make_shared<Object>();
    price->insert("defaultFare", Value(numStr(p.defaultFare)));
    auto segs = std::make_shared<Array>();
    for (const PriceSegment &s : p.segments) {
        auto o = std::make_shared<Object>();
        o->insert("lo", Value(numStr(s.lo)));
        o->insert("hi", Value(numStr(s.hi)));
        o->insert("fare", Value(numStr(s.fare)));
        segs->items.push_back(Value(o));
    }
    price->insert("segments", Value(segs));
    std::string linear;
    if (p.linearExtension.present)
        linear = "LINEAR_EXTENSION THRESHOLD " + numStr(p.linearExtension.threshold) +
                 " BASE_FARE " + numStr(p.linearExtension.base) +
                 " RATE_PER_KM " + numStr(p.linearExtension.rate);
    price->insert("linearLine", Value(linear));
    root->insert("price", Value(price));

    auto raws = std::make_shared<Array>();
    for (const RawLine &r : p.raw) raws->items.push_back(Value(r.text));
    root->insert("rawLines", Value(raws));

    return tmpl::renderValues(templates::k_decompile, {{"p", Value(root)}},
                              templates::snippets());
}

} // namespace metro
