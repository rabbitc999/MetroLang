/**
 * @file json.cpp
 * @brief 模型 <-> JSON（用仓库的 library/json 投影）。
 *
 * 字段口径对齐 metro_editor 的 route_data.json：顶层 key_city / author /
 * version / operation_params / price / transfer_types / stations / lines /
 * transfers / open_times。整数按整数写、浮点按最简形式写。
 */
#include "metro_model.hpp"

#include "json/json.hpp"

#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

namespace metro {
namespace {

using json::Array;
using json::Object;
using json::Value;

/** @brief 数字 -> JSON：整数值写成整数，避免 80.0 这类噪声。 */
Value jnum(double v) {
    if (std::fabs(v - std::llround(v)) < 1e-9) return Value(static_cast<std::int64_t>(std::llround(v)));
    return Value(v);
}

/** @brief 字符串 -> JSON。 */
Value jstr(const std::string &s) { return Value(s); }

/** @brief 取成员的字符串。 */
std::string str(const Value *v, const std::string &fallback = "") {
    if (v == nullptr) return fallback;
    const auto s = v->asString();
    return s ? std::string(*s) : fallback;
}

/** @brief 取成员的数值。 */
double num(const Value *v, double fallback = 0.0) {
    if (v == nullptr) return fallback;
    const auto d = v->asDouble();
    return d ? *d : fallback;
}

/** @brief 取成员的布尔。 */
bool boolean(const Value *v, bool fallback = false) {
    if (v == nullptr) return fallback;
    const auto b = v->asBool();
    return b ? *b : fallback;
}

/** @brief 卫生间信息 -> JSON。 */
Object toiletObject(const ToiletInfo &t) {
    Object o;
    o.insert("position", jstr(t.position));
    o.insert("accessible", Value(t.accessible));
    o.insert("gender", jstr(t.gender));
    return o;
}

/**
 * @brief 站点无障碍设施 -> JSON（内联在站点对象里的 `accessibility`）。
 *
 * JSON v2 的口径：设施挂在站点上，而不是旧的根级 `facilities` 字典。
 * 只有出现过的条目才写出，缺省即"没有这条设施"。
 */
Object accessObject(const StationAccess &a) {
    Object o;
    if (a.hasToilet) o.insert("toilet", Value(toiletObject(a.toilet)));
    if (a.hasAccessibleToilet) o.insert("accessible_toilet", Value(toiletObject(a.accessibleToilet)));
    if (!a.elevators.empty()) {
        Array list;
        for (const ElevatorInfo &e : a.elevators) {
            Object x;
            x.insert("location", jstr(e.location));
            x.insert("accessible", Value(e.accessible));
            list.push_back(Value(std::move(x)));
        }
        o.insert("elevators", Value(std::move(list)));
    }
    if (a.hasWideGate) {
        Object w;
        w.insert("quantity", Value(a.wideGate.quantity));
        o.insert("wide_gate", Value(std::move(w)));
    }
    if (!a.escalators.empty()) {
        Array list;
        for (const EscalatorInfo &e : a.escalators) {
            Object x;
            x.insert("quantity", Value(e.quantity));
            x.insert("direction", jstr(e.direction));
            list.push_back(Value(std::move(x)));
        }
        o.insert("escalators", Value(std::move(list)));
    }
    if (a.hasTactilePaving) {
        Object t;
        t.insert("status", jstr(a.tactilePaving.status));
        o.insert("tactile_paving", Value(std::move(t)));
    }
    if (a.accessible) o.insert("accessible", Value(true));
    return o;
}

/** @brief JSON -> 卫生间信息。 */
ToiletInfo readToilet(const Value *v) {
    ToiletInfo t;
    if (v == nullptr) return t;
    t.position = str(v->find("position"), "paid_area");
    t.accessible = boolean(v->find("accessible"));
    t.gender = str(v->find("gender"), "mixed");
    return t;
}

/**
 * @brief 读字符串列表字段：v2 写成数组，同时也接受旧格式的单个字符串。
 *
 * `formation` / `link` 在旧 JSON 里是一个字符串，v2 起允许声明多条，
 * 统一写成数组；读的时候两种都认，老产物不会读不进来。
 */
void readStringList(const Value *v, std::vector<std::string> &out) {
    if (v == nullptr) return;
    if (const auto *arr = v->asArray()) {
        for (const Value &item : *arr) {
            const auto text = item.asString();
            if (text) out.push_back(std::string(*text));
        }
        return;
    }
    const auto text = v->asString();
    if (text) out.push_back(std::string(*text));
}

/** @brief 字符串数组 -> JSON。 */
Value strArray(const std::vector<std::string> &items) {
    Array a;
    for (const std::string &s : items) a.push_back(Value(s));
    return Value(std::move(a));
}

} // namespace

std::string toJson(const Program &p) {
    Object root;
    root.insert("key_city", jstr(p.keyCity));
    root.insert("author", jstr(p.author));
    root.insert("version", jstr(p.version));
    root.insert("create_date", jstr(p.createDate));
    root.insert("update_date", jstr(p.updateDate));
    root.insert("other_cities", strArray(p.otherCities));

    Object op;
    op.insert("inner_transfer_time", Value(p.transferTime));
    op.insert("out_station_transfer_time", Value(p.outStationTransferTime));
    op.insert("dwell_time", Value(p.dwellTime));
    op.insert("entry_time", Value(p.entryTime));
    op.insert("avg_board_time", Value(p.avgBoardTime));
    root.insert("operation_params", Value(std::move(op)));

    Object price;
    price.insert("currency", jstr(p.currency));
    price.insert("pricingType", jstr("distance"));
    price.insert("default_fare", jnum(p.defaultFare));
    Array segs;
    for (const PriceSegment &s : p.segments) {
        Object o;
        o.insert("rangeStart", jnum(s.lo));
        o.insert("rangeEnd", jnum(s.hi));
        o.insert("fare", jnum(s.fare));
        segs.push_back(Value(std::move(o)));
    }
    price.insert("segments", Value(std::move(segs)));
    if (p.linearExtension.present) {
        Object le;
        le.insert("threshold", jnum(p.linearExtension.threshold));
        le.insert("baseFare", jnum(p.linearExtension.base));
        le.insert("ratePerKm", jnum(p.linearExtension.rate));
        price.insert("linearExtension", Value(std::move(le)));
    }
    root.insert("price", Value(std::move(price)));

    Array types;
    for (const TransferType &t : p.transferTypes) {
        Object o;
        o.insert("id", jstr(t.id));
        o.insert("name", jstr(t.name));
        o.insert("time", Value(t.time));
        o.insert("status", jstr(t.status));
        o.insert("security_check", Value(t.securityCheck));
        types.push_back(Value(std::move(o)));
    }
    root.insert("transfer_types", Value(std::move(types)));

    // 站点写成**数组**而不是"以站名为键的字典"：同名车站可能出现在不同城市，
    // 用站名当键会互相覆盖。站名放进每个元素自己的 `name` 字段，按出现顺序保留。
    Array stations;
    for (const Station &s : p.stations) {
        Object v;
        v.insert("name", jstr(s.name));
        v.insert("lon", jnum(s.lon));
        v.insert("lat", jnum(s.lat));
        v.insert("city", jstr(s.city));
        v.insert("otherNames", strArray(s.otherNames));
        Array lines;
        for (const StationLineRef &r : s.lines) {
            Object o;
            o.insert("id", jstr(r.id));
            o.insert("start", jstr(r.start));
            o.insert("end", jstr(r.end));
            o.insert("status", jstr(r.status));
            lines.push_back(Value(std::move(o)));
        }
        v.insert("lines", Value(std::move(lines)));
        if (s.access.present) v.insert("accessibility", Value(accessObject(s.access)));
        stations.push_back(Value(std::move(v)));
    }
    root.insert("stations", Value(std::move(stations)));

    Object lines;
    for (const Line &l : p.lines) {
        Object v;
        v.insert("name", jstr(l.name));
        v.insert("color", jstr(l.color));
        v.insert("city", jstr(l.city));
        v.insert("formation", strArray(l.formations));
        v.insert("maxspeed", jnum(l.maxspeed));
        v.insert("open_year", Value(l.openYear));
        v.insert("power_kw", jnum(l.power));
        v.insert("brake", jnum(l.brake));
        v.insert("link", strArray(l.links));
        v.insert("image", jstr(l.image));
        v.insert("disabled", Value(l.disabled));
        v.insert("special", Value(l.special));
        v.insert("pending", strArray(l.pending));
        Array dirs;
        for (const Direction &d : l.directions) {
            Object o;
            o.insert("id", jstr(d.id));
            o.insert("start", jstr(d.stations.empty() ? "" : d.stations.front().name));
            o.insert("end", jstr(d.stations.empty() ? "" : d.stations.back().name));
            o.insert("is_loop", Value(d.loop));
            o.insert("is_future", Value(d.isFuture));
            o.insert("direction_type", jstr(d.directionType));
            Array st;
            for (const DirStation &ds : d.stations) {
                Object e;
                e.insert("name", jstr(ds.name));
                // 带上所属城市：站名可能跨城市重名，方向里只写名字的话读端分不清是哪一座。
                // 城市取自站点表；站点没有城市时退回线路的 CITY。
                const Station *sn = p.findStation(ds.name);
                e.insert("city", jstr(sn != nullptr && !sn->city.empty() ? sn->city : l.city));
                e.insert("next", ds.hasNext ? jnum(ds.next) : Value(nullptr));
                e.insert("dwell_time", ds.dwell < 0 ? Value(nullptr) : jnum(ds.dwell));
                st.push_back(Value(std::move(e)));
            }
            o.insert("station", Value(std::move(st)));
            Array rt;
            for (const Routing &r : d.routings) {
                Object ro;
                ro.insert("name", jstr(r.name));
                ro.insert("stations", strArray(r.stations));
                rt.push_back(Value(std::move(ro)));
            }
            o.insert("routings", Value(std::move(rt)));
            dirs.push_back(Value(std::move(o)));
        }
        v.insert("direction", Value(std::move(dirs)));
        lines.insert(l.id, Value(std::move(v)));
    }
    root.insert("lines", Value(std::move(lines)));

    Array transfers;
    for (const Transfer &t : p.transfers) {
        int time = t.hasTime ? t.time : p.transferTime;
        for (const TransferType &tt : p.transferTypes) if (tt.id == t.type) time = tt.time;
        Object o;
        o.insert("type", jstr(t.type));
        o.insert("station", jstr(t.station));
        o.insert("from", jstr(t.lineA));
        o.insert("to", jstr(t.lineB));
        o.insert("time", Value(time));
        transfers.push_back(Value(std::move(o)));
    }
    root.insert("transfers", Value(std::move(transfers)));

    Array openTimes;
    for (const OpenTime &t : p.openTimes) {
        Object o;
        o.insert("id", jstr(t.id));
        o.insert("from", jstr(t.from));
        o.insert("to", jstr(t.to));
        o.insert("days", jstr(t.days));
        openTimes.push_back(Value(std::move(o)));
    }
    root.insert("open_times", Value(std::move(openTimes)));

    return Value(std::move(root)).dump(2) + "\n";
}

bool fromJson(const std::string &json, Program &out, std::vector<std::string> &errors) {
    const json::ParseResult doc = json::parse(json);
    if (!doc.ok()) {
        errors.push_back(doc.diagnostics.empty() ? std::string("JSON 解析失败")
                                                 : doc.diagnostics.front().toString());
        return false;
    }
    const Value &root = *doc.value;
    out = Program();
    out.keyCity = str(root.find("key_city"));
    out.author = str(root.find("author"), "匿名");
    out.version = str(root.find("version"), "V1.0");
    out.createDate = str(root.find("create_date"));
    out.updateDate = str(root.find("update_date"));
    if (const Value *oc = root.find("other_cities"); oc && oc->isArray())
        for (const Value &c : *oc->asArray()) out.otherCities.push_back(str(&c));
    if (const Value *op = root.find("operation_params"); op && op->isObject()) {
        out.transferTime = static_cast<int>(num(op->find("inner_transfer_time"), 180));
        out.outStationTransferTime = static_cast<int>(num(op->find("out_station_transfer_time"), 300));
        out.dwellTime = static_cast<int>(num(op->find("dwell_time"), 30));
        out.entryTime = static_cast<int>(num(op->find("entry_time"), 120));
        out.avgBoardTime = static_cast<int>(num(op->find("avg_board_time"), 3));
    }
    if (const Value *pr = root.find("price"); pr && pr->isObject()) {
        out.currency = str(pr->find("currency"), "CNY");
        out.defaultFare = num(pr->find("default_fare"));
        out.fareCap = num(pr->find("fareCap"));
        if (const Value *segs = pr->find("segments"); segs && segs->isArray())
            for (const Value &s : *segs->asArray())
                out.segments.push_back(PriceSegment{num(s.find("rangeStart")), num(s.find("rangeEnd")), num(s.find("fare"))});
        if (const Value *le = pr->find("linearExtension"); le && le->isObject()) {
            out.linearExtension.present = true;
            out.linearExtension.threshold = num(le->find("threshold"));
            out.linearExtension.base = num(le->find("baseFare"));
            out.linearExtension.rate = num(le->find("ratePerKm"));
        }
    }
    if (const Value *tt = root.find("transfer_types"); tt && tt->isArray())
        for (const Value &t : *tt->asArray()) {
            TransferType x;
            x.id = str(t.find("id"));
            x.name = str(t.find("name"));
            x.time = static_cast<int>(num(t.find("time")));
            x.status = str(t.find("status"));
            x.securityCheck = boolean(t.find("security_check"));
            out.transferTypes.push_back(x);
        }
    // 站点数组（v2）；字典（键 = 站名）的旧写法仍然读得进来。
    std::vector<std::pair<std::string, const Value *>> stationEntries;
    if (const Value *st = root.find("stations"); st != nullptr) {
        if (const auto *arr = st->asArray()) {
            for (const Value &v : *arr)
                if (v.isObject()) stationEntries.emplace_back(str(v.find("name")), &v);
        } else if (const auto *obj = st->asObject()) {
            for (const auto &member : obj->members())
                if (member.value.isObject()) stationEntries.emplace_back(member.key, &member.value);
        }
    }
    {
        for (const auto &entry : stationEntries) {
            const std::string &key = entry.first;
            const Value &v = *entry.second;
            (void)key;
            Station s;
            s.name = str(v.find("name"));
            if (s.name.empty()) s.name = key;
            s.lon = num(v.find("lon"));
            s.lat = num(v.find("lat"));
            s.hasCoord = true;
            s.city = str(v.find("city"));
            if (const Value *on = v.find("otherNames"); on && on->isArray())
                for (const Value &n : *on->asArray()) s.otherNames.push_back(str(&n));
            if (const Value *ls = v.find("lines"); ls && ls->isArray())
                for (const Value &l : *ls->asArray())
                    s.lines.push_back(StationLineRef{str(l.find("id")), str(l.find("start")),
                                                     str(l.find("end")), str(l.find("status"))});
            if (const Value *ac = v.find("accessibility"); ac && ac->isObject()) {
                StationAccess a;
                a.present = true;
                if (const Value *t = ac->find("toilet"); t && t->isObject()) { a.hasToilet = true; a.toilet = readToilet(t); }
                if (const Value *t = ac->find("accessible_toilet"); t && t->isObject()) {
                    a.hasAccessibleToilet = true;
                    a.accessibleToilet = readToilet(t);
                    a.accessibleToilet.accessible = true;
                }
                if (const Value *el = ac->find("elevators"); el && el->isArray())
                    for (const Value &e : *el->asArray())
                        a.elevators.push_back(ElevatorInfo{str(e.find("location")), boolean(e.find("accessible"), true)});
                if (const Value *w = ac->find("wide_gate"); w && w->isObject()) {
                    a.hasWideGate = true;
                    a.wideGate.quantity = static_cast<int>(num(w->find("quantity")));
                }
                if (const Value *es = ac->find("escalators"); es && es->isArray())
                    for (const Value &e : *es->asArray())
                        a.escalators.push_back(EscalatorInfo{static_cast<int>(num(e.find("quantity"))),
                                                             str(e.find("direction"), "both")});
                if (const Value *tp = ac->find("tactile_paving"); tp && tp->isObject()) {
                    a.hasTactilePaving = true;
                    a.tactilePaving.status = str(tp->find("status"), "available");
                }
                a.accessible = boolean(ac->find("accessible"));
                s.access = a;
            }
            if (!s.name.empty()) out.stations.push_back(s);
        }
    }
    if (const Value *ls = root.find("lines"); ls && ls->isObject()) {
        const Object *obj = ls->asObject();
        for (const auto &member : obj->members()) {
            if (!member.value.isObject()) continue;
            const Value &v = member.value;
            Line l;
            l.id = member.key;
            l.name = str(v.find("name"));
            l.color = str(v.find("color"));
            l.city = str(v.find("city"));
            readStringList(v.find("formation"), l.formations);
            l.maxspeed = num(v.find("maxspeed"));
            l.openYear = static_cast<int>(num(v.find("open_year")));
            l.power = num(v.find("power_kw"));
            l.brake = num(v.find("brake"));
            readStringList(v.find("link"), l.links);
            l.image = str(v.find("image"));
            l.disabled = boolean(v.find("disabled"));
            l.special = boolean(v.find("special"));
            if (const Value *pd = v.find("pending"); pd && pd->isArray())
                for (const Value &n : *pd->asArray()) l.pending.push_back(str(&n));
            if (const Value *dirs = v.find("direction"); dirs && dirs->isArray())
                for (const Value &dv : *dirs->asArray()) {
                    Direction d;
                    d.id = str(dv.find("id"));
                    d.lineId = l.id;
                    d.loop = boolean(dv.find("is_loop"));
                    d.isFuture = boolean(dv.find("is_future"));
                    d.directionType = str(dv.find("direction_type"));
                    if (const Value *ss = dv.find("station"); ss && ss->isArray())
                        for (const Value &sv : *ss->asArray()) {
                            DirStation ds;
                            ds.name = str(sv.find("name"));
                            if (const Value *nv = sv.find("next"); nv && nv->isNumber()) { ds.next = num(nv); ds.hasNext = true; }
                            if (const Value *dw = sv.find("dwell_time"); dw && dw->isNumber()) ds.dwell = num(dw);
                            d.stations.push_back(ds);
                        }
                    if (const Value *rt = dv.find("routings"); rt && rt->isArray())
                        for (const Value &rv : *rt->asArray()) {
                            Routing r;
                            r.name = str(rv.find("name"));
                            if (const Value *rs = rv.find("stations"); rs && rs->isArray())
                                for (const Value &n : *rs->asArray()) r.stations.push_back(str(&n));
                            d.routings.push_back(r);
                        }
                    l.directions.push_back(d);
                }
            out.lines.push_back(l);
        }
    }
    if (const Value *tr = root.find("transfers"); tr && tr->isArray())
        for (const Value &t : *tr->asArray()) {
            Transfer x;
            x.type = str(t.find("type"));
            x.station = str(t.find("station"));
            x.lineA = str(t.find("from"));
            x.lineB = str(t.find("to"));
            if (const Value *tv = t.find("time"); tv && tv->isNumber()) { x.time = static_cast<int>(num(tv)); x.hasTime = true; }
            out.transfers.push_back(x);
        }
    if (const Value *ot = root.find("open_times"); ot && ot->isArray())
        for (const Value &t : *ot->asArray())
            out.openTimes.push_back(OpenTime{str(t.find("id")), str(t.find("from")), str(t.find("to")), str(t.find("days"))});
    return true;
}

} // namespace metro
