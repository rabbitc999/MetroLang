/**
 * @file route.cpp
 * @brief 线路查询：同线乘车边 + 同站换乘边上的 Dijkstra（时间最短）。
 */
#include "metro_model.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <map>
#include <queue>
#include <set>
#include <string>
#include <vector>

namespace metro {
namespace {

/** @brief 图节点：站名 + 线路 ID（空串表示"任意线路"的换乘节点）。 */
struct Node {
    std::string station;
    std::string line;
    bool operator<(const Node &o) const {
        return station < o.station || (station == o.station && line < o.line);
    }
};

/** @brief 一条边。 */
struct Edge { Node to; double seconds = 0; bool ride = false; };

/** @brief 时间文本：秒 -> `x 分 y 秒`。 */
std::string fmt(double sec) {
    int total = static_cast<int>(std::llround(sec));
    char b[64];
    std::snprintf(b, sizeof(b), "%d 分 %d 秒", total / 60, total % 60);
    return b;
}

} // namespace

std::string queryRoute(const Program &program, const std::string &from, const std::string &to,
                       const RouteOptions &options, std::string &error) {
    if (program.findStation(from) == nullptr) { error = "找不到起点站：" + from; return ""; }
    if (program.findStation(to) == nullptr) { error = "找不到终点站：" + to; return ""; }

    std::map<Node, std::vector<Edge>> graph;
    std::map<std::string, std::vector<std::string>> stationLines;

    for (const Line &l : program.lines) {
        for (const Direction &d : l.directions) {
            for (std::size_t i = 0; i + 1 < d.stations.size(); ++i) {
                double km = d.stations[i].next > 0 ? d.stations[i].next : 0.0;
                double run = segmentRunTimeSeconds(km, l.maxspeed);
                double dwell = d.stations[i].dwell >= 0 ? d.stations[i].dwell : program.dwellTime;
                Node a{d.stations[i].name, l.id}, b{d.stations[i + 1].name, l.id};
                graph[a].push_back(Edge{b, run + dwell, true});
                graph[b].push_back(Edge{a, run + dwell, true});
                stationLines[a.station].push_back(l.id);
                stationLines[b.station].push_back(l.id);
            }
        }
    }
    // 同站换乘边
    for (auto &kv : stationLines) {
        std::vector<std::string> &ids = kv.second;
        std::sort(ids.begin(), ids.end());
        ids.erase(std::unique(ids.begin(), ids.end()), ids.end());
        for (std::size_t i = 0; i < ids.size(); ++i) {
            for (std::size_t j = 0; j < ids.size(); ++j) {
                if (i == j) continue;
                int transfer = program.transferTime;
                for (const TransferType &t : program.transferTypes) {
                    (void)t;
                }
                for (const Transfer &t : program.transfers) {
                    if (t.station == kv.first &&
                        ((t.lineA == ids[i] && t.lineB == ids[j]) ||
                         (t.lineA == ids[j] && t.lineB == ids[i]))) {
                        int byType = program.transferTime;
                        for (const TransferType &tt : program.transferTypes)
                            if (tt.id == t.type) byType = tt.time;
                        transfer = t.hasTime ? t.time : byType;
                    }
                }
                double cost = transfer + (options.preferFewerTransfers ? 600.0 : options.transferPenalty);
                graph[Node{kv.first, ids[i]}].push_back(Edge{Node{kv.first, ids[j]}, cost, false});
            }
        }
    }

    // 多源：起点站的所有线路
    std::map<Node, double> dist;
    std::map<Node, std::pair<Node, bool>> prev;
    using Item = std::pair<double, Node>;
    std::priority_queue<Item, std::vector<Item>, std::greater<Item>> pq;
    std::string startLine;
    for (const Line &l : program.lines) {
        for (const Direction &d : l.directions) {
            bool has = false;
            for (const DirStation &s : d.stations) if (s.name == from) has = true;
            if (has) {
                Node n{from, l.id};
                dist[n] = 0.0;
                pq.push({0.0, n});
                if (startLine.empty()) startLine = l.id;
            }
        }
    }
    if (dist.empty()) { error = "起点站不在任何线路上：" + from; return ""; }

    Node goal{"", ""};
    while (!pq.empty()) {
        auto [cost, node] = pq.top();
        pq.pop();
        auto it = dist.find(node);
        if (it != dist.end() && cost > it->second + 1e-9) continue;
        if (node.station == to) { goal = node; break; }
        for (const Edge &e : graph[node]) {
            double nd = cost + e.seconds;
            auto f = dist.find(e.to);
            if (f == dist.end() || nd < f->second - 1e-9) {
                dist[e.to] = nd;
                prev[e.to] = {node, e.ride};
                pq.push({nd, e.to});
            }
        }
    }
    if (goal.station.empty()) { error = "没有找到从 " + from + " 到 " + to + " 的路径"; return ""; }

    // 回溯
    std::vector<std::pair<Node, bool>> path;
    for (Node cur = goal;;) {
        auto p = prev.find(cur);
        if (p == prev.end()) { path.push_back({cur, false}); break; }
        path.push_back({cur, p->second.second});
        cur = p->second.first;
    }
    std::reverse(path.begin(), path.end());

    std::string out;
    out += from + " → " + to + "\n";
    out += "总耗时约 " + fmt(dist[goal]) + "\n";
    int rides = 0, transfers = 0;
    std::string curLine;
    for (const auto &step : path) {
        if (step.first.line.empty()) continue;
        if (step.first.line != curLine) {
            out += "  线路 " + step.first.line + "：";
            curLine = step.first.line;
        }
        out += step.first.station + " ";
    }
    out += "\n";
    for (std::size_t i = 1; i < path.size(); ++i) {
        if (!path[i].second) ++transfers;
        else ++rides;
    }
    out += "共 " + std::to_string(rides) + " 段乘车，" + std::to_string(transfers) + " 次换乘\n";
    if (options.preferFewerTransfers) out += "（已优先少换乘）\n";
    return out;
}

} // namespace metro
