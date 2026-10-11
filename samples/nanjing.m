# 数据集信息
PROGRAM_DEFINE
    KEY_CITY '南京'
    OTHER_CITY ['镇江', '马鞍山']
    VERSION 'V1.0'
    UPDATE_DATE '2026-7-18'
    CREATE_DATE '2026-6-30'
END_DEFINE

# 车站列表
%INCLUDE 'TRANSFER.m'
%import 'NANJING.csv' AS STATIONS

# ===== 运营公司 =====
OPERATOR_DEFINE NJMETRO
    NAME '南京地铁集团有限公司'
    SHORT_NAME '南京地铁'
    EN_NAME 'Nanjing Metro'
    COUNTRY '中国'
    CITY '南京'
    FOUNDED 1999
    WEBSITE 'https://www.njmetro.com.cn'
    HOTLINE '025-51899999'
    DESCRIPTION '南京市城市轨道交通运营主体'
    LINES ['NJ1', 'NJ2', 'NJ3', 'NJ4', 'NJ5', 'NJ6', 'NJ7', 'NJ10', 'NJ_S1', 'NJ_S2', 'NJ_S3', 'NJ_S7', 'NJ_S8', 'NJ_S9']
END_DEFINE

# ===== 区域定义 =====
ZONE_DEFINE ZN_XINJIEKOU
    NAME '新街口商圈'
    TYPE COMMERCIAL
    CITY '南京'
    COLOR '#F50057'
    CENTER 118.778500, 32.043500
    RADIUS 800
    STATIONS ['新街口', '张府园', '珠江路', '上海路', '大行宫']
    ATTRIBUTES
        PEAK_HOURS ['11:00-13:00', '18:00-20:00']
        POPULATION_DENSITY 4.5
        AVG_RENT 18000
    END_ATTRIBUTES
END_DEFINE

ZONE_DEFINE ZN_HEXI
    NAME '河西CBD'
    TYPE CBD
    CITY '南京'
    COLOR '#FF6D00'
    CENTER 118.699700, 32.014000
    RADIUS 2000
    STATIONS ['元通', '奥体中心', '中胜', '奥体东', '梦都大街', '兴隆大街']
    ATTRIBUTES
        PEAK_HOURS ['08:30-09:30', '17:30-18:30']
        POPULATION_DENSITY 3.0
        AVG_RENT 12000
    END_ATTRIBUTES
END_DEFINE

ZONE_DEFINE ZN_NJNANZHAN
    NAME '南京南站枢纽'
    TYPE TRANSPORT_HUB
    CITY '南京'
    COLOR '#2962FF'
    CENTER 118.797800, 31.971500
    RADIUS 1200
    STATIONS ['南京南站', '宏运大道', '明发广场', '双龙大道']
    ATTRIBUTES
        PEAK_HOURS ['07:00-09:00', '17:00-20:00']
        POPULATION_DENSITY 2.5
        AVG_RENT 8000
    END_ATTRIBUTES
END_DEFINE

ZONE_DEFINE ZN_FUZIMIAO
    NAME '夫子庙-秦淮风光带'
    TYPE TOURIST
    CITY '南京'
    COLOR '#00C853'
    CENTER 118.789000, 32.021500
    RADIUS 800
    STATIONS ['夫子庙', '三山街', '武定门', '常府街']
    ATTRIBUTES
        PEAK_HOURS ['10:00-12:00', '19:00-21:00']
        POPULATION_DENSITY 3.8
        AVG_RENT 10000
    END_ATTRIBUTES
END_DEFINE

ZONE_DEFINE ZN_XIANLIN
    NAME '仙林大学城'
    TYPE EDUCATIONAL
    CITY '南京'
    COLOR '#AA00FF'
    CENTER 118.914000, 32.104000
    RADIUS 2500
    STATIONS ['南大仙林校区', '羊山公园', '仙林中心', '学则路', '仙林湖', '经天路']
    ATTRIBUTES
        PEAK_HOURS ['07:30-08:30', '16:30-17:30']
        POPULATION_DENSITY 2.0
        AVG_RENT 5500
    END_ATTRIBUTES
END_DEFINE

# 线路定义
LINE_DEFINE NJ10
  NAME '10号线'
  COLOR '#F8BC28'
  FORMATION '6A'
  MAXSPEED 80.00
  OPEN_YEAR 2014
  LINK 'https://baike.baidu.com/item/%E5%8D%97%E4%BA%AC%E5%9C%B0%E9%93%8110%E5%8F%B7%E7%BA%BF'
  DIRECTION_DEFINE NJ10_0
    STATIONS ['东麒路', '石杨路', '杨庄', '高桥门', '承天大道', '大校场', '机场跑道旧址', '卡子门', '雨花台', '共青团路', '安德门', '小行', '中胜', '元通', '奥体中心', '梦都大街', '绿博园', '江心洲', '浦口万汇城', '南京工业大学', '龙华路', '文德路', '雨山路']
    DISTANCE [1.530000, 1.090000, 1.950000, 1.340000, 0.620000, 1.120000, 1.660000, 1.460000, 0.670000, 1.180000, 1.880000, 1.240000, 1.400000, 1.560000, 0.810000, 1.190000, 1.370000, 5.420000, 1.100000, 1.240000, 1.160000, 1.590000, NIL]
  END_DEFINE
  DIRECTION_DEFINE NJ10_1 REV NJ10_0
END_DEFINE

LINE_DEFINE NJ2
  NAME '2号线'
  COLOR '#C8003F'
  FORMATION '6A'
  MAXSPEED 80.00
  OPEN_YEAR 2010
  LINK 'https://baike.baidu.com/item/%E5%8D%97%E4%BA%AC%E5%9C%B0%E9%93%812%E5%8F%B7%E7%BA%BF'
  DIRECTION_DEFINE NJ2_0
    STATIONS ['经天路', '南大仙林校区', '羊山公园', '仙林中心', '学则路', '仙鹤门', '金马路', '马群', '钟灵街', '孝陵卫', '下马坊', '苜蓿园', '明故宫', '西安门', '大行宫', '新街口', '上海路', '汉中门', '莫愁湖', '云锦路', '集庆门大街', '兴隆大街', '奥体东', '元通', '雨润大街', '油坊桥', '螺塘路', '青莲街', '天保街', '鱼嘴']
    DISTANCE [1.800000, 1.910000, 1.070000, 1.520000, 1.330000, 1.490000, 2.660000, 2.690000, 1.130000, 0.910000, 1.290000, 1.460000, 1.330000, 1.020000, 1.030000, 0.740000, 0.850000, 1.000000, 1.080000, 1.080000, 1.470000, 1.370000, 1.210000, 1.340000, 1.930000, 2.010000, 0.890000, 1.260000, 0.900000, NIL]
  END_DEFINE
  DIRECTION_DEFINE NJ2_1 REV NJ2_0
END_DEFINE

LINE_DEFINE NJ1
  NAME '1号线'
  COLOR '#00A2E1'
  FORMATION '6A'
  MAXSPEED 80.00
  OPEN_YEAR 2005
  LINK 'https://baike.baidu.com/item/%E5%8D%97%E4%BA%AC%E5%9C%B0%E9%93%811%E5%8F%B7%E7%BA%BF'
  DIRECTION_DEFINE NJ1_0
    STATIONS ['八卦洲大桥南', '笆斗山', '燕子矶', '吉祥庵', '晓庄', '迈皋桥', '红山动物园', '南京站', '新模范马路', '玄武门', '鼓楼', '珠江路', '新街口', '张府园', '三山街', '中华门', '安德门', '天隆寺', '软件大道', '花神庙', '南京南站', '双龙大道', '河定桥', '胜太路', '百家湖', '小龙湾', '竹山路', '天印大道', '龙眠大道', '南医大·江苏经贸学院', '南京交院', '中国药科大学']
    DISTANCE [1.210000, 1.110000, 1.050000, 0.990000, 1.910000, 1.050000, 1.120000, 1.450000, 1.070000, 1.290000, 0.870000, 1.040000, 1.190000, 0.900000, 1.900000, 2.080000, 1.410000, 1.110000, 1.060000, 1.430000, 1.980000, 1.390000, 0.860000, 1.320000, 1.160000, 1.140000, 1.900000, 1.310000, 1.430000, 2.670000, 1.910000, NIL]
    ROUTING '1号线原线' ['迈皋桥', '红山动物园', '南京站', '新模范马路', '玄武门', '鼓楼', '珠江路', '新街口', '张府园', '三山街', '中华门', '安德门', '天隆寺', '软件大道', '花神庙', '南京南站', '双龙大道', '河定桥', '胜太路', '百家湖', '小龙湾', '竹山路', '天印大道', '龙眠大道', '南医大·江苏经贸学院', '南京交院', '中国药科大学']
  END_DEFINE
  DIRECTION_DEFINE NJ1_1 REV NJ1_0
END_DEFINE

LINE_DEFINE NJ3
  NAME '3号线'
  COLOR '#009551'
  FORMATION '6A'
  MAXSPEED 80.00
  OPEN_YEAR 2015
  LINK 'https://baike.baidu.com/item/%E5%8D%97%E4%BA%AC%E5%9C%B0%E9%93%813%E5%8F%B7%E7%BA%BF'
  DIRECTION_DEFINE NJ3_0
    STATIONS ['林场', '星火路', '东大成贤学院', '泰冯路', '天润城', '柳洲东路', '上元门', '五塘广场', '小市', '南京站', '南京林业大学·新庄', '鸡鸣寺', '浮桥', '大行宫', '常府街', '夫子庙', '武定门', '雨花门', '卡子门', '大明路', '明发广场', '南京南站', '宏运大道', '胜太西路', '天元西路', '九龙湖', '诚信大道', '东大九龙湖校区', '秣周东路', '上秦淮西', '秣陵']
    DISTANCE [2.490000, 1.010000, 1.070000, 1.490000, 1.690000, 3.510000, 0.920000, 1.880000, 1.220000, 1.910000, 2.470000, 0.880000, 0.830000, 0.990000, 1.030000, 1.230000, 1.110000, 0.970000, 1.130000, 0.970000, 0.890000, 1.320000, 1.740000, 1.790000, 1.750000, 1.200000, 1.360000, 3.000000, 2.160000, 1.000000, NIL]
  END_DEFINE
  DIRECTION_DEFINE NJ3_1 REV NJ3_0
END_DEFINE

LINE_DEFINE NJ_S1
  NAME 'S1号线'
  COLOR '#45BDB4'
  FORMATION '6B'
  MAXSPEED 100.00
  OPEN_YEAR 2003
  LINK 'https://baike.baidu.com/item/%E5%8D%97%E4%BA%AC%E5%9C%B0%E9%93%81S1%E5%8F%B7%E7%BA%BF'
  DIRECTION_DEFINE NJ_S1_0
    STATIONS ['空港新城江宁', '禄口机场', '翔宇路南', '翔宇路北', '正方中路', '吉印大道', '河海大学·佛城西路', '翠屏山', '南京南站']
    DISTANCE [1.550000, 5.000000, 4.110000, 6.170000, 4.690000, 3.060000, 3.270000, 3.390000, NIL]
  END_DEFINE
  DIRECTION_DEFINE NJ_S1_1 REV NJ_S1_0
END_DEFINE

LINE_DEFINE NJ_S8
  NAME 'S8号线'
  COLOR '#EDA155'
  FORMATION '4B'
  MAXSPEED 100.00
  OPEN_YEAR 2014
  LINK 'https://baike.baidu.com/item/%E5%8D%97%E4%BA%AC%E5%9C%B0%E9%93%81S8%E5%8F%B7%E7%BA%BF'
  DIRECTION_DEFINE NJ_S8_0
    STATIONS ['金牛湖', '八百桥', '沈桥', '方洲广场', '凤凰山公园', '雄州', '龙池', '六合开发区', '化工园', '长芦', '葛塘', '大厂', '卸甲甸', '信息工程大学', '高新开发区', '泰冯路', '泰山新村', '毛纺厂路', '长江大桥北']
    DISTANCE [5.170000, 4.910000, 5.990000, 1.460000, 1.600000, 2.290000, 2.110000, 2.870000, 1.560000, 3.890000, 2.150000, 1.820000, 1.400000, 2.840000, 2.630000, 1.130000, 1.470000, 0.710000, NIL]
    ROUTING 'S8号线原线' ['金牛湖', '八百桥', '沈桥', '方洲广场', '凤凰山公园', '雄州', '龙池', '六合开发区', '化工园', '长芦', '葛塘', '大厂', '卸甲甸', '信息工程大学', '高新开发区', '泰冯路']
  END_DEFINE
  DIRECTION_DEFINE NJ_S8_1 REV NJ_S8_0
END_DEFINE

LINE_DEFINE NJ_S3
  NAME 'S3号线'
  COLOR '#B984AC'
  FORMATION '6B'
  MAXSPEED 100.00
  OPEN_YEAR 2017
  LINK 'https://baike.baidu.com/item/%E5%8D%97%E4%BA%AC%E5%9C%B0%E9%93%81S3%E5%8F%B7%E7%BA%BF'
  DIRECTION_DEFINE NJ_S3_0
    STATIONS ['高家冲', '林山', '桥林新城', '石碛河', '双垅', '兰花塘', '马骡圩', '刘村', '天保', '高庙路', '吴侯街', '平良大街', '永初路', '油坊桥', '贾西', '春江路', '铁心桥', '景明佳园', '南京南站']
    DISTANCE [1.700000, 1.990000, 1.350000, 1.450000, 1.310000, 2.090000, 7.900000, 1.510000, 2.030000, 0.860000, 0.910000, 0.980000, 1.150000, 1.570000, 1.330000, 1.570000, 1.380000, 2.040000, NIL]
  END_DEFINE
  DIRECTION_DEFINE NJ_S3_1 REV NJ_S3_0
END_DEFINE

LINE_DEFINE NJ_S7
  NAME 'S7号线'
  COLOR '#E99A96'
  FORMATION '6B'
  MAXSPEED 100.00
  OPEN_YEAR 2003
  LINK 'https://baike.baidu.com/item/%E5%8D%97%E4%BA%AC%E5%9C%B0%E9%93%81S7%E5%8F%B7%E7%BA%BF'
  DIRECTION_DEFINE NJ_S7_0
    STATIONS ['空港新城江宁', '柘塘', '空港新城溧水', '群力', '卧龙湖', '溧水', '中山湖', '幸庄', '无想山']
    DISTANCE [5.200000, 5.510000, 2.730000, 4.720000, 2.720000, 1.700000, 2.470000, 1.800000, NIL]
  END_DEFINE
  DIRECTION_DEFINE NJ_S7_1 REV NJ_S7_0
END_DEFINE

LINE_DEFINE NJ_S9
  NAME 'S9号线'
  COLOR '#F8BC28'
  FORMATION '6B'
  MAXSPEED 80.00
  OPEN_YEAR 2026
  LINK 'https://baike.baidu.com/item/%E5%8D%97%E4%BA%AC%E5%9C%B0%E9%93%81S9%E5%8F%B7%E7%BA%BF'
  DIRECTION_DEFINE NJ_S9_0
    STATIONS ['高淳', '团结圩', '明觉', '石湫', '铜山', '翔宇路南']
    DISTANCE [6.170000, 16.800000, 10.460000, 6.660000, 8.200000, NIL]
  END_DEFINE
  DIRECTION_DEFINE NJ_S9_1 REV NJ_S9_0
END_DEFINE

LINE_DEFINE NJ4
  NAME '4号线'
  COLOR '#7B6FB1'
  FORMATION '6B'
  MAXSPEED 80.00
  OPEN_YEAR 2017
  LINK 'https://baike.baidu.com/item/%E5%8D%97%E4%BA%AC%E5%9C%B0%E9%93%814%E5%8F%B7%E7%BA%BF'
  DIRECTION_DEFINE NJ4_0
    STATIONS ['龙江', '草场门·南艺·二师', '云南路', '鼓楼', '鸡鸣寺', '九华山', '岗子村', '蒋王庙', '王家湾', '聚宝山', '徐庄·苏宁总部', '金马路', '汇通路', '灵山', '东流', '孟北', '西岗桦墅', '仙林湖']
    DISTANCE [1.530000, 1.790000, 0.810000, 1.350000, 0.790000, 1.310000, 1.980000, 1.090000, 2.680000, 2.420000, 2.240000, 2.490000, 1.160000, 1.970000, 2.260000, 1.830000, 2.970000, NIL]
  END_DEFINE
  DIRECTION_DEFINE NJ4_1 REV NJ4_0
END_DEFINE

LINE_DEFINE NJ6
  NAME '6号线'
  COLOR '#45BDB4'
  FORMATION '6B'
  MAXSPEED 80.00
  OPEN_YEAR 2024
  LINK 'https://baike.baidu.com/item/%E5%8D%97%E4%BA%AC%E5%9C%B0%E9%93%816%E5%8F%B7%E7%BA%BF'
  DIRECTION_DEFINE NJ6_0
    STATIONS ['句容', '崇明', '华阳', '童世界', '黄梅', '泉都大街', '汤山', '南京猿人洞', '古泉', '东郊小镇', '麒麟门', '百水桥', '马群']
    DISTANCE [2.460000, 3.290000, 2.660000, 4.850000, 6.630000, 2.230000, 2.110000, 4.270000, 5.310000, 2.380000, 1.210000, 1.930000, NIL]
  END_DEFINE
  DIRECTION_DEFINE NJ6_1 REV NJ6_0
END_DEFINE

LINE_DEFINE NJ7
  NAME '7号线'
  COLOR '#246F36'
  FORMATION '6A'
  MAXSPEED 80.00
  OPEN_YEAR 2022
  LINK 'https://baike.baidu.com/item/%E5%8D%97%E4%BA%AC%E5%9C%B0%E9%93%817%E5%8F%B7%E7%BA%BF'
  DIRECTION_DEFINE NJ7_0
    STATIONS ['西善桥', '螺塘路', '太清路', '永初路', '嘉陵江东街', '中胜', '新城科技园', '梦都大街东', '应天大街', '南湖', '大士茶亭', '莫愁湖', '清凉山', '草场门·南艺·二师', '古平岗', '福建路', '钟阜路', '幕府西路', '五塘广场', '幕府山', '晓庄', '万寿', '丁家庄', '丁家庄南', '尧化新村', '尧化门', '仙新路']
    DISTANCE [1.940000, 0.570000, 1.330000, 1.590000, 0.810000, 0.800000, 1.370000, 1.430000, 0.930000, 0.930000, 0.670000, 1.230000, 1.420000, 1.170000, 1.010000, 1.690000, 1.460000, 0.920000, 2.070000, 2.020000, 1.460000, 1.700000, 1.050000, 1.710000, 1.380000, 0.870000, NIL]
  END_DEFINE
  DIRECTION_DEFINE NJ7_1 REV NJ7_0
END_DEFINE

LINE_DEFINE NJ5
  NAME '5号线'
  COLOR '#FEE818'
  FORMATION '6A'
  MAXSPEED 80.00
  OPEN_YEAR 2024
  LINK 'https://baike.baidu.com/item/%E5%8D%97%E4%BA%AC%E5%9C%B0%E9%93%815%E5%8F%B7%E7%BA%BF'
  DIRECTION_DEFINE NJ5_0
    STATIONS ['方家营', '南京西站', '静海寺', '下关', '盐仓桥', '福建路', '虹桥', '青春广场', '云南路', '五台山', '上海路', '朝天宫', '三山街', '夫子庙', '通济门', '光华门', '石门坎', '七桥瓮', '大校场', '神机营', '东山香樟园', '文靖路', '东山', '新亭路', '竹山路', '科宁路', '前庄', '诚信大道', '九龙湖南', '吉印大道']
    DISTANCE [1.080000, 0.560000, 0.670000, 1.050000, 0.880000, 0.770000, 1.030000, 0.970000, 1.100000, 0.900000, 1.090000, 1.420000, 0.750000, 1.290000, 1.010000, 1.150000, 0.970000, 1.170000, 1.010000, 2.420000, 1.510000, 0.570000, 1.250000, 1.210000, 0.880000, 1.630000, 1.170000, 2.740000, 1.620000, NIL]
  END_DEFINE
  DIRECTION_DEFINE NJ5_1 REV NJ5_0
END_DEFINE

LINE_DEFINE NJ_S2
  NAME 'S2号线'
  COLOR '#B02427'
  FORMATION '6B'
  MAXSPEED 100.00
  OPEN_YEAR 2025
  LINK 'https://baike.baidu.com/item/%E5%8D%97%E4%BA%AC%E5%9C%B0%E9%93%81S2%E5%8F%B7%E7%BA%BF'
  DIRECTION_DEFINE NJ_S2_0
    STATIONS ['太白', '姑孰', '马鞍山经开区', '阳湖', '雨山东路', '湖南路・安工大', '湖北路・二中', '慈湖高新区', '铜井', '牧龙', '江宁滨江开发区', '江宁镇', '板桥南', '板桥', '雨花经济开发区', '西善桥']
    DISTANCE [3.780000, 7.570000, 2.670000, 2.340000, 1.180000, 2.000000, 5.730000, 6.900000, 4.290000, 2.100000, 2.870000, 2.130000, 2.470000, 3.300000, 3.150000, NIL]
  END_DEFINE
  DIRECTION_DEFINE NJ_S2_1 REV NJ_S2_0
END_DEFINE

# 运营参数
OPERATION_DEFINE
  TRANSFER_TIME 300
  OUT_STATION_TRANSFER_TIME 600
  DWELL_TIME 45
  ENTRY_TIME 120
END_DEFINE

# 票价规则
PRICE_DEFINE
  DEFAULT_FARE 2.00
  SEGMENT 0.00 4.00 2.00
  SEGMENT 4.00 9.00 3.00
  SEGMENT 9.00 16.00 4.00
  SEGMENT 16.00 25.00 5.00
  SEGMENT 25.00 36.00 6.00
  SEGMENT 36.00 49.00 7.00
  SEGMENT 49.00 64.00 8.00
  SEGMENT 64.00 81.00 9.00
  SEGMENT 81.00 100.00 10.00
  LINEAR_EXTENSION THRESHOLD 100.00 BASE_FARE 10.00 RATE_PER_KM 0.100000
END_DEFINE

# ===== 换乘定义（类型引用） =====
# 新街口（1、2）
TRANSFER STAIR "新街口" NJ1 NJ2

# 大行宫（2、3）
TRANSFER HALL "大行宫" NJ2 NJ3

# 南京南站（1、3、S1、S3）
TRANSFER HALL "南京南站" NJ1 NJ3
TRANSFER CHANNEL "南京南站" NJ1 NJ_S1
TRANSFER CHANNEL "南京南站" NJ1 NJ_S3
TRANSFER CHANNEL "南京南站" NJ3 NJ_S1
TRANSFER CHANNEL "南京南站" NJ3 NJ_S3
TRANSFER CHANNEL "南京南站" NJ_S1 NJ_S3

# 安德门（1、10）
TRANSFER HALL "安德门" NJ1 NJ10

# 元通（2、10）
TRANSFER STAIR "元通" NJ2 NJ10

# 鼓楼（1、4）
TRANSFER HALL "鼓楼" NJ1 NJ4

# 鸡鸣寺（3、4）
TRANSFER STAIR "鸡鸣寺" NJ3 NJ4

# 泰冯路（3、S8）
TRANSFER HALL "泰冯路" NJ3 NJ_S8

# 油坊桥（2、S3）
TRANSFER STAIR "油坊桥" NJ2 NJ_S3

# 螺塘路（2、7）
TRANSFER HALL "螺塘路" NJ2 NJ7

# 永初路（S3、7）
TRANSFER HALL "永初路" NJ_S3 NJ7

# 晓庄（1、7）
TRANSFER HALL "晓庄" NJ1 NJ7

# 竹山路（1、5）
TRANSFER HALL "竹山路" NJ1 NJ5

# 诚信大道（3、5）
TRANSFER HALL "诚信大道" NJ3 NJ5

# 吉印大道（S1、5）
TRANSFER HALL "吉印大道" NJ_S1 NJ5

# 马群（2、6）
TRANSFER CHANNEL "马群" NJ2 NJ6

# 金马路（2、4）
TRANSFER HALL "金马路" NJ2 NJ4

# 福建路（7、5）
TRANSFER HALL "福建路" NJ7 NJ5

# 上海路（2、5）
TRANSFER HALL "上海路" NJ2 NJ5

# 三山街（1、5）
TRANSFER STAIR "三山街" NJ1 NJ5

# 夫子庙（3、5）
TRANSFER HALL "夫子庙" NJ3 NJ5

# 卡子门（3、10）
TRANSFER HALL "卡子门" NJ3 NJ10

# 南京站（1、3）
TRANSFER HALL "南京站" NJ1 NJ3

# 翔宇路南（S1、S9）
TRANSFER HALL "翔宇路南" NJ_S1 NJ_S9

# 空港新城江宁（S1、S7）
TRANSFER HALL "空港新城江宁" NJ_S1 NJ_S7

# 草场门·南艺·二师（4、7）
TRANSFER HALL "草场门·南艺·二师" NJ4 NJ7

# 五塘广场（3、7）
TRANSFER HALL "五塘广场" NJ3 NJ7

# 中胜（10、7）
TRANSFER HALL "中胜" NJ10 NJ7

# 莫愁湖（2、7）
TRANSFER HALL "莫愁湖" NJ2 NJ7

# ===== 运营时间 =====
OPEN_TIME GLOBAL 06:00 23:00

OPEN_TIME NJ1 06:00 23:30
OPEN_TIME NJ2 06:00 23:30
OPEN_TIME NJ3 06:00 23:00
OPEN_TIME NJ4 06:00 23:00
OPEN_TIME NJ5 06:00 22:30
OPEN_TIME NJ6 06:00 22:30
OPEN_TIME NJ7 06:00 23:00
OPEN_TIME NJ10 06:00 23:00
OPEN_TIME NJ_S1 06:00 22:30
OPEN_TIME NJ_S2 06:00 22:00
OPEN_TIME NJ_S3 06:00 22:30
OPEN_TIME NJ_S7 06:00 22:00
OPEN_TIME NJ_S8 06:00 22:30
OPEN_TIME NJ_S9 06:00 22:00
