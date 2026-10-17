# 区间运行时间与出行时间估算模型

本文整理自 `metro_editor/doc/列车运行时间计算.md`，给出地铁区间运行时间、站台等待
时间与总出行时间的推导口径。`metro-lang route` 的最短路权重就用这里的模型。

> **实现状态**：本文的模型已在 `src/train_time.cpp`（区间运行时间）、
> `src/route.cpp`（图搜索与总时间）中落地，并由 `tests/test_numeric.py` 的 22 项断言
> 守住数值口径。工期与公式的对应关系、以及"哪些是近似"见各节末尾的实现注记。
> 路线规划的完整口径见 `doc/05-route.md`。

## 0. 实现注记：自适应辛普森积分

恒功率牵引阶段的 $\mathrm{d}t/\mathrm{d}v = m v / (P - v R(v))$ 没有初等原函数，
`src/train_time.cpp` 用**自适应辛普森**数值积分：

- 短区间（≤ 1.5 km）：牵引 + 惰行 + 制动三段分别精确积分；
- 长区间：`S / v_max + ΔT`，其中 `ΔT` 由同车型的 10 km 参考区间标定。

这样长区间的计算量与距离无关，全部 465 个站的广州样例 route 查询仍在毫秒级完成。


## 1. 物理基础与假设

纵向动力学：

$$m\,\frac{\mathrm{d}v}{\mathrm{d}t} = F_{\text{trac}} - F_{\text{res}} - F_{\text{brake}}$$

运行策略为 **牵引 → 巡航 → 惰行 → 制动** 四阶段。模型假设：

1. 牵引功率恒定（不随速度变化）；
2. 阻力用 Davis 公式，系数做保守放大；
3. 制动为恒定减速度；
4. 忽略坡道、曲线、隧道附加阻力；
5. 忽略启动冲击、车门开关、乘降等站停时间（站停另计，见 §8）；
6. 列车准点、乘客到达独立于时刻表；
7. 停靠时间足够长（$\tau > t$）。

## 2. 阻力模型：Davis 公式

单位基本阻力 $r(v) = a + b v + c v^2$（N/kN），总阻力
$F_{\text{res}} = r(v)\,W$，其中 $W = m_{\text{ton}} g$、$g = 9.81\,\text{m/s}^2$，
结果为牛顿。不同车型的原始系数：

| 车型 | a (N/kN) | b (N/kN·m⁻¹·s) | c (N/kN·m⁻²·s²) |
|---|---|---|---|
| A | 2.0895 | 0.0098 | 0.006 |
| B | 1.65 | 0.0247 | 0.00128 |
| L | 1.87 | 0.0196 | 0.00102 |
| D | 2.3 | 0.012 | 0.007 |

为保证结果偏大（保守），系数再乘放大系数（默认 1.1；早期推导示例用 1.2）。

## 3. 牵引阶段：恒功率

$F_{\text{trac}}(v) = P/v$；$v < 0.5$ m/s 时用最大牵引力限幅。运动方程
$m\,\mathrm{d}v/\mathrm{d}t = P/v - F_{\text{res}}(v)$ 整理得
$\mathrm{d}t/\mathrm{d}v = m v / \bigl(P - v F_{\text{res}}(v)\bigr)$，于是

$$t_{\text{acc}}(v)=\int_0^{v}\frac{m u}{P-uF_{\text{res}}(u)}\,\mathrm{d}u,\qquad
s_{\text{acc}}(v)=\int_0^{v}\frac{m u^2}{P-uF_{\text{res}}(u)}\,\mathrm{d}u$$

功率限制速度 $v_{\text{lim}}$ 满足 $v_{\text{lim}} F_{\text{res}}(v_{\text{lim}}) = P$，
可达最高速 $v_{\text{reach}} = \min(v_{\max},\ v_{\text{lim}})$。数值积分取
$v_{\text{eff}} = 0.99\,v_{\text{reach}}$ 以避免上限处发散（影响可忽略）。

## 4. 制动阶段：恒定减速度

$$s_{\text{brake}}=\frac{v_{\text{reach}}^2}{2a_{\text{brake}}},\qquad
t_{\text{brake}}=\frac{v_{\text{reach}}}{a_{\text{brake}}}$$

默认 $a_{\text{brake}} = 0.85\,\text{m/s}^2$（取小值 → 时间偏长 → 结果保守）。

## 5. 区间总运行时间

- **有巡航段**（$s_{\text{acc}} + s_{\text{brake}} \le S$）：
  $s_{\text{cruise}} = S - s_{\text{acc}} - s_{\text{brake}}$，
  $t_{\text{cruise}} = s_{\text{cruise}}/v_{\text{reach}}$，
  $T_{\text{run}} = t_{\text{acc}} + t_{\text{cruise}} + t_{\text{brake}}$。
- **无巡航段**（短区间）：二分求峰值速度 $v_p$ 使
  $s_{\text{acc}}(v_p) + v_p^2/(2a_{\text{brake}}) = S$，则
  $T_{\text{run}} = t_{\text{acc}}(v_p) + v_p/a_{\text{brake}}$。

## 6. 简化线性模型（工具链实际使用）

长区间（功率充足、>$1$ km）可用线性近似，误差 < 1 s 且偏大：

$$\boxed{\,T_{\text{run}}(S) = \frac{S}{v_{\max}} + \Delta T\,}$$

$\Delta T$ 是**与区间长度无关的固定附加时间**，用参考区间
$S_{\text{ref}} = 10000$ m 精确积分得到 $\Delta T = T_{\text{ref}} - S_{\text{ref}}/v_{\max}$。

**`metro-lang` 的实现**：为便于纯几何计算，取

$$T = \frac{S}{v_{\max}} + \frac{v_{\max}}{2}\left(\frac{1}{a_{\text{acc}}} + \frac{1}{a_{\text{brake}}}\right),
\quad a_{\text{acc}} = 1.0,\ a_{\text{brake}} = 0.85\ \text{m/s}^2$$

即用加减速段各 $v/(2a)$ 的固定损耗近似 $\Delta T$；$v_{\max}$ 缺省取 80 km/h。
见 `metro-lang/src/model.cpp::segmentRunTimeSeconds`。

## 7. 站台平均等待时间（含拥挤）

- $T$：发车间隔；$t$：最短上车时间；$p$：单趟挤上的概率；$C = 1/p$：拥挤度
  （平均需等待的列车总趟数，含首次尝试，从 1 起算）。

首次到达的平均剩余等待为 $T/2$，加上上车准备时间 $t$ 得
$E[W_1] = T/2 + t$；失败次数服从几何分布，期望 $E[K] = (1-p)/p$，每次额外等一整
间隔 $T$。于是

$$\boxed{\,E[W] = \frac{T}{2} + t + (C-1)\,T = t + \left(C - \tfrac{1}{2}\right)T\,}$$

特例：$C=1$（无拥挤）$E[W] = T/2 + t$；$p \to 0$ 时 $E[W] \to \infty$。
数值例：$T = 120$ s、$t = 3$ s、$C = 2$ → $183$ s。

## 8. 总出行时间

$$\boxed{
T_{\text{total}} = 2t_{\text{access}}
+ \sum_{i \in \mathcal{R}}\left(\frac{S_i}{v_{\max,i}} + \Delta T_i + \tau_i N_i\right)
+ \sum_{k \in \mathcal{K}}\left(\frac{T_k}{2} + t_k + (C_k-1)T_k\right)
}$$

- $t_{\text{access}}$：单次进出闸机/上下车步行时间（两端共 2 次）；
- $N_i$：区段 $i$ 的**中间站**数（总站数 − 2）；$\tau_i$：每站停站附加时间；
- $\mathcal{R}$：乘车区段集合；$\mathcal{K}$：换乘事件集合。

$N_i = 0$ 时停站项为 0；无换乘时换乘项为 0。拥挤度推荐值：宽松 1、一般 1.3–1.5、
拥挤 1.8–2.2、非常拥挤 2.5–3.5。

## 9. 参数汇总

| 参数 | 符号 | 默认 | 单位 |
|---|---|---|---|
| 线路限速 | $v_{\max}$ | 80 | km/h |
| 牵引功率 | $P$ | 2000 | kW |
| 制动减速度 | $a_{\text{brake}}$ | 0.85 | m/s² |
| 参考区间 | $S_{\text{ref}}$ | 10000 | m |
| 阻力放大 | $\kappa$ | 1.1 | — |
| 发车间隔 | $T$、$T_k$ | 120–180 | s |
| 最短上车时间 | $t$、$t_k$ | 3–5 | s |
| 拥挤度 | $C$、$C_k$ | 1–4 | — |
| 进出站步行 | $t_{\text{access}}$ | 60–120 | s |
| 停站附加 | $\tau_i$ | 30–45 | s |

## 10. 编组解析规则

`FORMATION`（如 `4/8A`、`6B`、`8节磁浮`）解析：

1. 取出所有数字，**最大值**作为节数；
2. 取第一个字母作为车型；
3. 车型白名单 `A/B/L/D`，不在名单内退化为 `B`；
4. 节数 > 12 时强制回退为 `6B`。

## 11. 适用范围

城市地铁 / 市域铁路（≤ 120 km/h）、站间距 ≥ 500 m、功率充足能达限速的正常运营
通勤估算。因阻力放大、制动减速度取小值，结果**偏大（保守）**，适合通勤时间预留。

## 12. 公式速查

- 区间（物理）：$T_{\text{run}} = t_{\text{acc}} + (S - s_{\text{acc}} - s_{\text{brake}})/v_{\text{reach}} + t_{\text{brake}}$（有巡航段）；
- 区间（线性）：$T_{\text{run}}(S) = S/v_{\max} + \Delta T$；
- 等待：$E[W] = T/2 + t + (C-1)T$；
- 总时间：见 §8。
