#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 metro-lang 的 JSON v2 精简成游戏用数据集。

输入是 `metro-lang compile` 写出的 JSON v2（口径见 ``doc/02-json-format.md``），
输出是一份只含模拟需要字段的 JSON，体积约为原文件的五分之一，可直接被
``game/js/sim.js`` 读取。

用法：

    python game/tools/prepare_data.py build/check/full.json -o game/data/guangzhou.json

精简掉的东西：
  * ``stations[].otherNames`` —— 只画站名，别名不用；
  * ``lines[].link`` / ``image`` / ``power_kw`` / ``brake`` —— 展示用字段；
  * ``transfers`` 里时间超出口径的冗余项 —— 只保留每个（站，线路对）最快的一条。

补上的东西（都写在输出的 ``meta`` 里，方便复核）：
  * 每个（车站，线路）的**唯一站序**：同一线路可能有多个方向、多个交路，
    这里按行驶方向拼成一条完整的站序链，并给出相邻两站的**区间里程**；
  * 各线路的站间最高速度（km/h），缺省 80；
  * 每站的停站时间（秒），按 ``dwell_rules`` 的 node → line → 默认 顺序取值。
"""

import argparse
import json
import math
import sys

# ---------------------------------------------------------------------------
# 常量：与 doc/03-travel-time-model.md §9 一致
# ---------------------------------------------------------------------------

DEFAULT_MAXSPEED = 80.0        # km/h，数据缺 maxspeed 时的兜底
DEFAULT_DWELL = 30.0           # s，dwell_rules 全都没命中时的兜底
ACCEL = 1.0                    # m/s²，doc/03 §6
BRAKE = 0.85                   # m/s²，doc/03 §6
REVERSAL = 45.0                # s，终点折返（驾驶换端）时间，游戏口径


def haversine_km(a, b):
    """两站球面距离（km）；坐标缺失时返回 None。"""
    if not a or not b:
        return None
    try:
        lon1, lat1, lon2, lat2 = float(a['lon']), float(a['lat']), float(b['lon']), float(b['lat'])
    except (KeyError, TypeError, ValueError):
        return None
    if any(math.isnan(v) for v in (lon1, lat1, lon2, lat2)):
        return None
    r = 6371.0088
    rad = math.pi / 180.0
    dlat = (lat2 - lat1) * rad
    dlon = (lon2 - lon1) * rad
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1 * rad) * math.cos(lat2 * rad) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(h)))


def build_station_index(data):
    """站名 → 站点（保留 lon/lat/city），数组与字典两种输入都吃。"""
    out = {}
    raw = data.get('stations') or []
    items = raw if isinstance(raw, list) else [
        dict(name=name, **(raw[name] or {})) for name in raw
    ]
    for s in items:
        if not s or not s.get('name'):
            continue
        out[s['name']] = {
            'name': s['name'],
            'lon': s.get('lon'),
            'lat': s.get('lat'),
            'city': s.get('city') or data.get('key_city') or '',
        }
    return out


# ---------------------------------------------------------------------------
# 站序链：把一条线路的所有方向拼成「一条主链 + 若干支线」
# ---------------------------------------------------------------------------

def _sequence_of(direction):
    """方向 → (站名列表, 每站到下一站的里程列表)。"""
    raw = direction.get('station') or []
    names, dists = [], []
    for s in raw:
        if isinstance(s, dict):
            names.append(s.get('name'))
            dists.append(s.get('next'))
        else:
            names.append(s)
            dists.append(None)
    return names, dists


def canonical_chain(directions):
    """从一条线路的多个方向里挑出「主链」和「支线」，拼成统一的站序。

    做法：
      1. 对每条方向取出站名序列，把里程转成「站名 → 下一站」字典，正反向都登记
         （数据里 ``next`` 只表示本站到下一站，反向走同一段时查不到，见
         ``doc/05-route.md`` §6 的踩坑记录）；
      2. 选站数最多的方向作主链；
      3. 其余方向里，凡是主链覆盖不到的站，接成支线：找到与主链的**唯一**重合站
         作为挂接点，支线本身也按序列保留方向。

    返回 ``{'main': [...], 'branches': [[...], ...], 'dist': {...}}``，
    其中 ``main`` / ``branches`` 的每一项是站名，``dist`` 是 ``'甲>乙' -> km``。
    """
    if not directions:
        return {'main': [], 'branches': [], 'dist': {}}

    dist = {}

    def remember(a, b, km):
        if not a or not b or a == b:
            return
        if isinstance(km, (int, float)) and km > 0:
            key = a + '>' + b
            if key not in dist:
                dist[key] = float(km)
            rev = b + '>' + a
            if rev not in dist:
                dist[rev] = float(km)

    seqs = []
    for d in directions:
        names, dists = _sequence_of(d)
        names = [n for n in names if n]
        if len(names) < 2:
            continue
        seqs.append((names, dists))
        for i in range(len(names) - 1):
            remember(names[i], names[i + 1], dists[i])
        for i in range(len(names) - 2, -1, -1):
            # 反向：第 i 段等于正向的第 i 段（不是 i+1，见 doc/05 §6）。
            remember(names[i + 1], names[i], dists[i])

    if not seqs:
        return {'main': [], 'branches': [], 'dist': {}}

    seqs.sort(key=lambda kv: -len(kv[0]))
    main = list(seqs[0][0])
    covered = set(main)
    branches = []

    # 主链之外的站，按「与已覆盖部分的交界」串成支线：
    # 一条方向里，过滤掉已覆盖的站之后剩下的连续段就是一条支线。
    for names, _ in seqs[1:]:
        run = []
        for name in names + [None]:
            if name is None or name in covered:
                if len(run) >= 2:
                    branches.append(run)
                    covered.update(run)
                elif len(run) == 1:
                    covered.add(run[0])
                run = []
            else:
                run.append(name)
    # 去重：同一段正反两个方向会各来一遍。
    uniq = []
    for b in branches:
        key = frozenset(b)
        if any(frozenset(u) == key for u in uniq):
            continue
        uniq.append(b)
    return {'main': main, 'branches': uniq, 'dist': dist}


# ---------------------------------------------------------------------------
# 时刻规则：发车间隔 / 停站时间 / 高峰系数
# ---------------------------------------------------------------------------

def _to_seconds(hhmm):
    """'07:30' → 27000 秒。解析不了返回 None。"""
    if not isinstance(hhmm, str) or ':' not in hhmm:
        return None
    try:
        h, m = hhmm.split(':')[:2]
        return int(h) * 3600 + int(m) * 60
    except ValueError:
        return None


def flatten_periods(rules, weekday='mon'):
    """把 headway_rules 的「时段表」摊平成 [[起秒, 止秒, 值], ...]，按起点排序。

    只取指定的星期；某条规则该星期没定义时段时整条跳过（游戏只模拟工作日）。
    """
    out = {}
    for rule in rules or []:
        rid = rule.get('id')
        periods = []
        for p in rule.get('periods') or []:
            days = p.get('days') or []
            if days and weekday not in days:
                continue
            a, b = _to_seconds(p.get('from')), _to_seconds(p.get('to'))
            if a is None or b is None or b <= a:
                continue
            value = p.get('seconds', p.get('factor'))
            if value is None:
                continue
            periods.append([a, b, float(value)])
        if periods:
            periods.sort(key=lambda x: x[0])
            out[rid] = periods
    return out


def dwell_lookup(rules, stations):
    """停站时间：node 级优先，其次 line 级，最后默认值。"""
    by_station, by_line, default = {}, {}, DEFAULT_DWELL
    for r in rules or []:
        sec = r.get('seconds')
        if not isinstance(sec, (int, float)):
            continue
        scope = r.get('scope')
        if scope == 'node' and r.get('station'):
            # 同一站写了两次（数据里确实有）时取小的那个，避免重复覆盖。
            prev = by_station.get(r['station'])
            by_station[r['station']] = sec if prev is None else min(prev, sec)
        elif scope == 'line' and r.get('line'):
            by_line[r['line']] = float(sec)
        elif scope in (None, 'global') and r.get('line') is None and r.get('station') is None:
            default = float(sec)
    # 站名 → {站名: 秒} 按站输出，没命中的在运行时回落到线路级 / 默认值。
    station_dwell = {name: by_station[name] for name in by_station if name in stations}
    return {'station': station_dwell, 'line': by_line, 'default': default}


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def prepare(data, city_note=''):
    stations = build_station_index(data)
    lines_in = data.get('lines') or {}
    dwell = dwell_lookup(data.get('dwell_rules'), stations)
    headways = flatten_periods(data.get('headway_rules'))
    crowd = flatten_periods(data.get('crowd_rules'))

    lines = []
    line_stations = {}   # 站名 → [线路 id]
    for lid, ln in lines_in.items():
        dirs = ln.get('direction') or []
        # 全部在建的线路不参与模拟（玩家没法调度）。
        operating = [d for d in dirs if not d.get('is_future')]
        chain = canonical_chain(operating)
        if len(chain['main']) < 2:
            continue
        vmax = ln.get('maxspeed') or DEFAULT_MAXSPEED
        try:
            vmax = float(vmax)
        except (TypeError, ValueError):
            vmax = DEFAULT_MAXSPEED
        if vmax <= 0:
            vmax = DEFAULT_MAXSPEED

        # 区间里程：主链逐段查表，查不到就用球面距离。
        def segment_km(a, b):
            km = chain['dist'].get(a + '>' + b)
            if km:
                return round(km, 3)
            km = haversine_km(stations.get(a), stations.get(b))
            return round(km, 3) if km else 0.0

        def seq_with_km(names):
            return {
                'stations': names,
                'km': [segment_km(names[i], names[i + 1]) for i in range(len(names) - 1)],
            }

        entry = {
            'id': lid,
            'name': ln.get('name') or lid,
            'color': ln.get('color') or '#888888',
            'city': ln.get('city') or data.get('key_city') or '',
            'formation': ' / '.join(ln.get('formation') or []) if isinstance(ln.get('formation'), list) else (ln.get('formation') or ''),
            'maxspeed': vmax,
            'open_year': ln.get('open_year') or 0,
            'main': seq_with_km(chain['main']),
            'branches': [seq_with_km(b) for b in chain['branches']],
            'dwell': dwell['line'].get(lid, dwell['default']),
        }
        lines.append(entry)
        for names in [chain['main']] + chain['branches']:
            for name in names:
                line_stations.setdefault(name, [])
                if lid not in line_stations[name]:
                    line_stations[name].append(lid)

    # 线路按名字排序，界面与图例顺序稳定。
    lines.sort(key=lambda e: (_line_order(e['name']), e['name']))

    # 跨城市重名（广州 2号线 / 佛山 2号线）：名字前补城市，否则玩家分不清。
    name_count = {}
    for e in lines:
        name_count[e['name']] = name_count.get(e['name'], 0) + 1
    for e in lines:
        if name_count.get(e['name'], 0) > 1:
            city = e['city'] or '外地'
            e['display'] = city + e['name']
        else:
            e['display'] = e['name']

    # 站表只保留真正被线路用到的站，顺带记下所属线路。
    used = {}
    for name in line_stations:
        if name in stations:
            used[name] = stations[name]
    for name, s in used.items():
        s['lines'] = sorted(line_stations[name], key=lambda lid: [e['id'] for e in lines].index(lid)
                            if lid in [e['id'] for e in lines] else 999)

    price = data.get('price') or {}
    op = data.get('operation_params') or {}
    transfer_types = {t.get('id'): t for t in (data.get('transfer_types') or []) if t.get('id')}

    out = {
        'format': 'metro-game-1',
        'source': {
            'key_city': data.get('key_city') or '',
            'version': data.get('version') or '',
            'update_date': data.get('update_date') or '',
            'note': city_note,
        },
        'params': {
            'exit_time': float(op.get('entry_time') or 120),
            'inner_transfer_time': float(op.get('inner_transfer_time') or 300),
            'avg_board_time': float(op.get('avg_board_time') or 3),
            'reversal_time': REVERSAL,
            'accel': ACCEL,
            'brake': BRAKE,
        },
        'price': {
            'default_fare': price.get('default_fare', 2),
            'segments': price.get('segments') or [],
        },
        'transfer_types': {
            k: {'name': v.get('name') or k, 'time': float(v.get('time') or 240)}
            for k, v in transfer_types.items()
        },
        'stations': used,
        'lines': lines,
        'headway': headways,
        'crowd': crowd,
    }
    return out


def _line_order(name):
    """线路名排序键：'2号线' → (True, 2, '')，'APM线' → (False, -1, 'APM线')。"""
    digits = ''
    for ch in str(name):
        if ch.isdigit():
            digits += ch
        elif digits:
            break
    if digits:
        return (True, int(digits), str(name))
    return (False, -1, str(name))


def main(argv=None):
    ap = argparse.ArgumentParser(description='把 metro-lang JSON v2 精简成游戏数据集')
    ap.add_argument('source', help='metro-lang compile 产出的 JSON，例如 build/check/full.json')
    ap.add_argument('-o', '--output', default='game/data/guangzhou.json', help='输出路径')
    args = ap.parse_args(argv)

    with open(args.source, 'r', encoding='utf-8') as f:
        data = json.load(f)

    out = prepare(data)
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))

    total_dir_stations = sum(len(l['main']['stations']) + sum(len(b['stations']) for b in l['branches'])
                             for l in out['lines'])
    print('线路 %d 条，车站 %d 座（线路站次 %d），输出 %s'
          % (len(out['lines']), len(out['stations']), total_dir_stations, args.output))
    return 0


if __name__ == '__main__':
    sys.exit(main())
