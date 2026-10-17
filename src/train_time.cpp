/**
 * @file train_time.cpp
 * @brief 区间运行时间的物理模型：metro_editor `SimTrainTimeUtils` 的逐步移植。
 *
 * 口径与 C# 版保持一致（同一个 Davis 系数、同一个 1.2 放大、同一个 10 km 参考区间
 * 标定 ΔT、同一个 1.5 km 分界），所以两边对同一份数据应当给出同一个秒数。
 * `doc/03-travel-time-model.md` 是这套公式的说明文档。
 */
#include "metro_model.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <map>
#include <mutex>
#include <string>

namespace metro {
namespace {

constexpr double kGravity = 9.81;
constexpr double kDefaultBrake = 0.85;
/// Davis 系数的保守放大倍数（C# 里叫 DavisScale）。
constexpr double kDavisScale = 1.2;
/// 长区间用线性模型，短区间用精确积分；分界点与 C# 相同。
constexpr double kShortThresholdKm = 1.5;
/// ΔT 标定用的参考区间（m）。
constexpr double kReferenceDistanceM = 10000.0;

/** @brief 一种车型：每节质量 + Davis 三项系数。 */
struct CarSpec { double massTon; double a, b, c; };

/** @brief 车型表（A/B/L/C/D）。 */
const std::map<char, CarSpec> &carSpecs() {
    static const std::map<char, CarSpec> table = {
        {'A', {36.5, 2.0895, 0.0098, 0.006}},
        {'B', {33.3, 1.65, 0.0247, 0.00128}},
        {'L', {30.0, 1.87, 0.0196, 0.00102}},
        {'C', {34.0, 1.80, 0.0200, 0.0015}},
        {'D', {37.5, 2.3, 0.012, 0.007}},
    };
    return table;
}

/** @brief 编组解析结果。 */
struct Consist {
    char carType = 'B';  ///< 车型（白名单外退化为 B）。
    int cars = 6;        ///< 节数。
};

/**
 * @brief 解析编组字符串（`6B` / `4/8A` / `8节磁浮`）。
 *
 * 规则（与 C# `ParseConsist` 一致）：取所有数字的最大值当节数（> 12 回退 6），
 * 取第一个字母当车型，车型不在 A/B/L/C/D 里退化为 B。
 *
 * @param text 编组文本。
 * @return 解析结果。
 */
Consist parseConsist(const std::string &text) {
    Consist out;
    if (text.empty()) return out;
    int cars = 6;
    for (char ch : text) {
        if (ch >= '0' && ch <= '9') {
            const int value = ch - '0';
            if (value > cars) cars = value;
        }
    }
    if (cars > 12) cars = 6;
    out.cars = cars;
    // C# 版正则是 `[A-Za-z]` 取第一个字母，没在白名单里就退化为 B —— 这里同样
    // 只看第一个字母，不往后找，否则 `6-AT` 这类写法会跟 C# 得出不同车型。
    for (char ch : text) {
        if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) {
            const char upper = static_cast<char>(ch >= 'a' ? ch - 'a' + 'A' : ch);
            out.carType = (upper == 'A' || upper == 'B' || upper == 'C' || upper == 'D' ||
                           upper == 'L')
                              ? upper
                              : 'B';
            break;
        }
    }
    return out;
}

/** @brief 自适应辛普森积分（与 C# `AdaptiveSimpson` 同结构）。 */
template <typename F>
double simpsonRecursive(F f, double a, double b, double fa, double fm, double fb,
                        double whole, double eps, int maxDepth, int depth) {
    const double mid = (a + b) / 2;
    const double leftMid = (a + mid) / 2;
    const double rightMid = (mid + b) / 2;
    const double fLeft = f(leftMid);
    const double fRight = f(rightMid);
    const double left = (mid - a) * (fa + 4 * fLeft + fm) / 6.0;
    const double right = (b - mid) * (fm + 4 * fRight + fb) / 6.0;
    const double diff = left + right - whole;
    if (depth >= maxDepth || std::fabs(diff) < 15 * eps) return left + right + diff / 15.0;
    return simpsonRecursive(f, a, mid, fa, fLeft, fm, left, eps / 2, maxDepth, depth + 1) +
           simpsonRecursive(f, mid, b, fm, fRight, fb, right, eps / 2, maxDepth, depth + 1);
}

/** @brief 自适应辛普森积分入口。 */
template <typename F>
double adaptiveSimpson(F f, double a, double b, double eps, int maxDepth) {
    if (a > b) std::swap(a, b);
    if (a == b) return 0.0;
    const double mid = (a + b) / 2;
    const double fa = f(a), fm = f(mid), fb = f(b);
    const double whole = (b - a) * (fa + 4 * fm + fb) / 6.0;
    return simpsonRecursive(f, a, b, fa, fm, fb, whole, eps, maxDepth, 0);
}

/**
 * @brief 一次"加速段"的积分结果：耗时与走过距离。
 *
 * 被积函数来自 dv/dt = (P/v - R)/m，整理得 dt/dv = mv/(P - vR)、
 * ds/dv = mv²/(P - vR)。与 C# 的 `CalcAcceleration` 一字不差。
 */
struct AccelResult { double seconds = 0; double meters = 0; };

AccelResult integrateAccel(double vTarget, double massKg, double powerW, double a,
                           double b, double c, double weightKn) {
    if (vTarget <= 0) return {};
    const double vEff = vTarget * 0.99;
    auto resistance = [&](double v) { return (a + b * v + c * v * v) * weightKn; };
    auto integrandT = [&](double v) {
        const double denom = powerW - v * resistance(v);
        return denom > 1e-6 ? massKg * v / denom : 0.0;
    };
    auto integrandS = [&](double v) {
        const double denom = powerW - v * resistance(v);
        return denom > 1e-6 ? massKg * v * v / denom : 0.0;
    };
    const double eps = 1e-6;
    const int maxDepth = 200;
    AccelResult out;
    out.seconds = adaptiveSimpson(integrandT, 0, vEff, eps, maxDepth);
    out.meters = adaptiveSimpson(integrandS, 0, vEff, eps, maxDepth);
    return out;
}

/** @brief 功率限制速度：从 0.1 m/s 起以 0.05 步长找 P = v·R 的交点。 */
double powerLimitSpeed(double powerW, double a, double b, double c, double weightKn) {
    for (double v = 0.1; v <= 100.0; v += 0.05) {
        const double force = (a + b * v + c * v * v) * weightKn;
        if (v * force > powerW) return v;
    }
    return 50.0;
}

/**
 * @brief 精确积分求区间运行时间（C# `ComputeRunTimeExact`）。
 *
 * 先按限速与功率限制求可达速度 vReach，再算加速段（积分）/ 巡航段 / 制动段；
 * 距离不够加速到 vReach 时二分峰值速度。
 */
double runTimeExact(double distanceM, const std::string &consist, double vMaxKmh,
                    double powerKw, double brakeDecel) {
    const Consist info = parseConsist(consist);
    const auto &spec = carSpecs().at(info.carType);
    const double massTon = spec.massTon * info.cars;
    const double massKg = massTon * 1000.0;
    const double powerW = powerKw * 1000.0;
    const double vMax = vMaxKmh / 3.6;

    const double a = spec.a * kDavisScale;
    const double b = spec.b * kDavisScale;
    const double c = spec.c * kDavisScale;
    const double weightKn = massTon * kGravity;

    const double vLimit = powerLimitSpeed(powerW, a, b, c, weightKn);
    const double vReach = std::min(vMax, vLimit * 0.99);

    const AccelResult acc = integrateAccel(vReach, massKg, powerW, a, b, c, weightKn);
    const double tBrake = vReach / brakeDecel;
    const double sBrake = vReach * vReach / (2 * brakeDecel);

    if (acc.meters + sBrake <= distanceM) {
        const double sCruise = distanceM - acc.meters - sBrake;
        return acc.seconds + sCruise / vReach + tBrake;
    }
    // 短区间：二分峰值速度，使"加速距离 + 制动距离 = 区间长度"。
    double lo = 0.0, hi = vReach;
    for (int i = 0; i < 60; ++i) {
        const double mid = (lo + hi) / 2;
        const AccelResult probe = integrateAccel(mid, massKg, powerW, a, b, c, weightKn);
        if (probe.meters + mid * mid / (2 * brakeDecel) < distanceM) lo = mid;
        else hi = mid;
    }
    const double vPeak = (lo + hi) / 2;
    const AccelResult peak = integrateAccel(vPeak, massKg, powerW, a, b, c, weightKn);
    return peak.seconds + vPeak / brakeDecel;
}

/** @brief 参数指纹（ΔT 与短区间都按它做缓存）。 */
std::string cacheKey(const std::string &consist, double powerKw, double vMaxKmh, double brakeDecel) {
    char buffer[160];
    std::snprintf(buffer, sizeof(buffer), "%s|%.0f|%.0f|%.2f", consist.c_str(), powerKw, vMaxKmh,
                  brakeDecel);
    return buffer;
}

/**
 * @brief ΔT：参考区间精确积分减去匀速通过时间。
 *
 * 与 C# `GetDeltaT` 相同：只跟编组 / 功率 / 限速 / 制动有关，与区间长度无关，
 * 所以算一次缓存起来。
 */
double deltaT(const std::string &consist, double powerKw, double vMaxKmh, double brakeDecel) {
    static std::mutex mutex;
    static std::map<std::string, double> cache;
    const std::string key = "d|" + cacheKey(consist, powerKw, vMaxKmh, brakeDecel);
    std::lock_guard<std::mutex> lock(mutex);
    const auto found = cache.find(key);
    if (found != cache.end()) return found->second;
    const double tRef = runTimeExact(kReferenceDistanceM, consist, vMaxKmh, powerKw, brakeDecel);
    const double vMaxMs = vMaxKmh / 3.6;
    const double value = tRef - kReferenceDistanceM / vMaxMs;
    cache[key] = value;
    return value;
}

} // namespace

double segmentRunTimeExact(double distanceKm, const std::string &consist, double vMaxKmh,
                           double powerKw, double brakeDecel) {
    if (distanceKm <= 0) return 0.0;
    if (brakeDecel <= 0) brakeDecel = kDefaultBrake;
    if (vMaxKmh <= 0) vMaxKmh = 80.0;
    if (powerKw <= 0) powerKw = 2000.0;
    const double distanceM = distanceKm * 1000.0;

    if (distanceKm <= kShortThresholdKm) {
        // 短区间：精确积分比较贵（且结果只跟这五个参数有关），缓存起来。
        static std::mutex mutex;
        static std::map<std::string, double> cache;
        char head[64];
        std::snprintf(head, sizeof(head), "%.5f|", distanceKm);
        const std::string key = head + cacheKey(consist, powerKw, vMaxKmh, brakeDecel);
        {
            std::lock_guard<std::mutex> lock(mutex);
            const auto found = cache.find(key);
            if (found != cache.end()) return found->second;
        }
        const double value = runTimeExact(distanceM, consist, vMaxKmh, powerKw, brakeDecel);
        std::lock_guard<std::mutex> lock(mutex);
        cache[key] = value;
        return value;
    }
    const double vMaxMs = vMaxKmh / 3.6;
    return distanceM / vMaxMs + deltaT(consist, powerKw, vMaxKmh, brakeDecel);
}

} // namespace metro
