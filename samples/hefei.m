# 数据集信息
PROGRAM_DEFINE
    KEY_CITY '合肥'
    VERSION 'V1.0'
    UPDATE_DATE '2026-6-30'
END_DEFINE

%INCLUDE 'TRANSFER.m'
%IMPORT 'HEFEI.csv' AS STATIONS

# ===== 运营公司 =====
OPERATOR_DEFINE HFEZ
    NAME '合肥市轨道交通集团有限公司'
    SHORT_NAME '合肥轨道'
    EN_NAME 'Hefei Rail Transit'
    COUNTRY '中国'
    CITY '合肥'
    FOUNDED 2009
    WEBSITE 'https://www.hfrt.com.cn'
    HOTLINE '0551-62076666'
    DESCRIPTION '合肥市城市轨道交通运营主体'
    LINES ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8']
END_DEFINE

# ===== 区域定义 =====
ZONE_DEFINE ZN_BINHU
    NAME '滨湖新区'
    TYPE RESIDENTIAL
    CITY '合肥'
    COLOR '#0091EA'
    CENTER 117.319717, 31.719786
    RADIUS 3000
    STATIONS ['九联圩', '丙子铺', '万年埠', '万达城', '云谷路', '金斗公园', '塘西河公园', '紫庐', '滨湖会展中心']
    ATTRIBUTES
        PEAK_HOURS ['08:00-09:00', '17:30-18:30']
        POPULATION_DENSITY 2.5
        AVG_RENT 6000
    END_ATTRIBUTES
END_DEFINE

ZONE_DEFINE ZN_ZHENGWU
    NAME '政务文化新区'
    TYPE CBD
    CITY '合肥'
    COLOR '#FF6D00'
    CENTER 117.263890, 31.828000
    RADIUS 1500
    STATIONS ['市政务中心', '合肥大剧院', '图书馆', '洪岗', '天鹅湖', '天鹅湖东']
    ATTRIBUTES
        PEAK_HOURS ['08:30-09:30', '17:30-18:30']
        POPULATION_DENSITY 3.2
        AVG_RENT 9000
    END_ATTRIBUTES
END_DEFINE

ZONE_DEFINE ZN_HFNANZHAN
    NAME '合肥南站枢纽'
    TYPE TRANSPORT_HUB
    CITY '合肥'
    COLOR '#2962FF'
    CENTER 117.308483, 31.784000
    RADIUS 1000
    STATIONS ['合肥南站', '南站南广场', '望湖城', '望湖城西', '望湖城南']
    ATTRIBUTES
        PEAK_HOURS ['07:00-09:00', '17:00-20:00']
        POPULATION_DENSITY 2.0
        AVG_RENT 7000
    END_ATTRIBUTES
END_DEFINE

ZONE_DEFINE ZN_HFHCZ
    NAME '合肥火车站枢纽'
    TYPE TRANSPORT_HUB
    CITY '合肥'
    COLOR '#00C853'
    CENTER 117.349000, 31.868000
    RADIUS 800
    STATIONS ['合肥火车站', '瑶海公园', '长淮', '明光路']
    ATTRIBUTES
        PEAK_HOURS ['07:00-09:00', '17:00-19:00']
        POPULATION_DENSITY 2.8
        AVG_RENT 6500
    END_ATTRIBUTES
END_DEFINE

# 线路定义
LINE_DEFINE L1
  NAME '1号线'
  COLOR '#E61F26'
  FORMATION '6B'
  MAXSPEED 80.00
  OPEN_YEAR 2016
  LINK 'https://baike.baidu.com/item/%E5%90%88%E8%82%A5%E8%BD%A8%E9%81%93%E4%BA%A4%E9%80%9A1%E5%8F%B7%E7%BA%BF'
  DIRECTION_DEFINE L1_0
    STATIONS ['九联圩', '丙子铺', '万年埠', '万达城', '云谷路', '金斗公园', '塘西河公园', '紫庐', '滨湖会展中心', '高王', '骆岗', '南站南广场', '合肥南站', '望湖城', '葛大店', '秋浦河路', '朱岗', '合工大南区', '包公园', '大东门', '明光路', '长淮', '合肥火车站', '瑶海公园', '兴华苑', '张洼']
    DISTANCE AUTO
  END_DEFINE
  DIRECTION_DEFINE L1_1 REV L1_0
END_DEFINE

LINE_DEFINE L2
  NAME '2号线'
  COLOR '#0168B3'
  FORMATION '6B'
  MAXSPEED 80.00
  OPEN_YEAR 2017
  LINK 'https://baike.baidu.com/item/%E5%90%88%E8%82%A5%E8%BD%A8%E9%81%93%E4%BA%A4%E9%80%9A2%E5%8F%B7%E7%BA%BF'
  DIRECTION_DEFINE L2_0
    STATIONS ['撮镇', '南沙河', '马桥', '和睦湖', '肥东站', '排头', '店埠河', '对河', '桂王', '祥和', '三十埠东', '三十埠', '王岗', '龙岗', '东二十埠', '漕冲', '东七里', '东五里井', '三里街', '大东门', '四牌楼', '三孝口', '安农大', '三里庵', '五里墩', '西七里塘', '十里庙', '科学大道', '天柱路', '大蜀山', '蜀山西', '振兴路', '汽车西站', '桂庄', '南岗']
    DISTANCE AUTO
  END_DEFINE
  DIRECTION_DEFINE L2_1 REV L2_0
END_DEFINE

LINE_DEFINE L3
  NAME '3号线'
  COLOR '#00833D'
  FORMATION '6B'
  MAXSPEED 80.00
  OPEN_YEAR 2019
  LINK 'https://baike.baidu.com/item/%E5%90%88%E8%82%A5%E8%BD%A8%E9%81%93%E4%BA%A4%E9%80%9A3%E5%8F%B7%E7%BA%BF'
  DIRECTION_DEFINE L3_0
    STATIONS ['馆驿', '省儿童医院新区', '乐平', '芮祠', '四十埠', '李湾', '凉亭', '肥西人民医院', '幸福坝', '安大磬苑校区', '工大翡翠湖校区', '大学城北', '繁华大道', '安医大二附院', '省博物院', '图书馆', '合肥大剧院', '市政务中心', '洪岗', '国防科技大学', '西七里塘', '南新庄', '合肥西站', '杏花村', '四泉桥', '郑河', '海棠', '一里井', '淮南路', '鸭林冲', '合肥火车站', '竹丝滩', '方庙', '窦桥湾', '新海大道', '勤劳村', '文浍苑', '幼儿师范', '职教城', '职教城东', '相城路']
    DISTANCE AUTO
  END_DEFINE
  DIRECTION_DEFINE L3_1 REV L3_0
END_DEFINE

LINE_DEFINE L4
  NAME '4号线'
  COLOR '#F79727'
  FORMATION '6B'
  MAXSPEED 80.00
  OPEN_YEAR 2021
  LINK 'https://baike.baidu.com/item/%E5%90%88%E8%82%A5%E8%BD%A8%E9%81%93%E4%BA%A4%E9%80%9A4%E5%8F%B7%E7%BA%BF'
  DIRECTION_DEFINE L4_0
    STATIONS ['紫云湖', '烧脉岗', '魏庄', '铜锣寨路', '金小郢', '桃花潭', '长安集', '复兴集', '北雁湖', '玉兰大道', '金桂', '柳树塘', '图书馆', '天鹅湖', '天鹅湖东', '姚公庙', '南屏路', '薛河', '竹西', '淝南', '合肥南站', '望湖城南', '葛大店南', '工经学院', '尧渡河路', '五里庙', '唐桥', '东七里', '站塘', '方庙', '新海公园', '十里村', '陶冲湖东', '安医一附院北区', '综保区']
    DISTANCE AUTO
  END_DEFINE
  DIRECTION_DEFINE L4_1 REV L4_0
END_DEFINE

LINE_DEFINE L5
  NAME '5号线'
  COLOR '#C1D62F'
  FORMATION '6B'
  MAXSPEED 80.00
  OPEN_YEAR 2020
  LINK 'https://baike.baidu.com/item/%E5%90%88%E8%82%A5%E8%BD%A8%E9%81%93%E4%BA%A4%E9%80%9A5%E5%8F%B7%E7%BA%BF'
  DIRECTION_DEFINE L5_0
    STATIONS ['贵阳路', '滨湖竹园', '云川公园', '清水冲', '云谷路', '华山路', '沈湾', '渡江纪念馆', '方兴湖', '省行政中心东', '义城', '扬子江路', '黄河路', '花园大道', '大连路', '义兴', '包河苑', '盛大', '合肥南站', '望湖城西', '凌大塘', '休宁路', '市第三医院', '中国科大东区', '稻香楼', '三孝口', '杏花公园', '白水坝', '海棠', '北五里井', '菱湖公园', '六中菱湖校区', '汲桥路']
    DISTANCE AUTO
  END_DEFINE
  DIRECTION_DEFINE L5_1 REV L5_0
END_DEFINE

LINE_DEFINE L6
  NAME '6号线'
  COLOR '#BA96C4'
  FORMATION '6B'
  MAXSPEED 80.00
  OPEN_YEAR 2025
  LINK 'https://baike.baidu.com/item/%E5%90%88%E8%82%A5%E8%BD%A8%E9%81%93%E4%BA%A4%E9%80%9A6%E5%8F%B7%E7%BA%BF'
  DIRECTION_DEFINE L6_0
    STATIONS ['龙塘', '伏龙', '大兴集', '钢红', '市博物馆', '市儿童医院', '唐大楼', '尧渡河路', '朱岗', '卫岗', '市第三医院', '南七里', '陆军兵种大学', '洪岗', '松荫桥', '梦城', '开福寺', '北雁湖', '科大先研院', '量子科学中心', '合肥七中', '青龙岗']
    DISTANCE AUTO
  END_DEFINE
  DIRECTION_DEFINE L6_1 REV L6_0
END_DEFINE

LINE_DEFINE L7
  NAME '7号线'
  COLOR '#F1C646'
  FORMATION '6B'
  MAXSPEED 80.00
  OPEN_YEAR 2026
  LINK 'https://baike.baidu.com/item/%E5%90%88%E8%82%A5%E8%BD%A8%E9%81%93%E4%BA%A4%E9%80%9A7%E5%8F%B7%E7%BA%BF'
  DIRECTION_DEFINE L7_0
    STATIONS ['翡翠公园', '繁华大道', '徽园', '明珠广场', '天都路', '南艳湖北', '一六八中学', '合肥大学', '南艳湖南', '要素大市场', '滨湖医院', '紫庐', '嵩山路', '省文化和非遗馆', '义城', '合肥四中']
    DISTANCE AUTO
  END_DEFINE
  DIRECTION_DEFINE L7_1 REV L7_0
END_DEFINE

LINE_DEFINE L8
  NAME '8号线'
  COLOR '#5CAEE0'
  FORMATION '6B'
  MAXSPEED 100.00
  OPEN_YEAR 2024
  LINK 'https://baike.baidu.com/item/%E5%90%88%E8%82%A5%E8%BD%A8%E9%81%93%E4%BA%A4%E9%80%9A1%E5%8F%B7%E7%BA%BF'
  DIRECTION_DEFINE L8_0
    STATIONS ['北城高铁站', '省立医院北区', '双墩', '北城世纪城', '梅冲湖', '金梅路', '双凤', '荷塘路', '六中菱湖校区', '庐阳经开区', '杏林', '一里井']
    DISTANCE [2.250208, 1.800311, 2.026120, 1.824246, 2.132954, 2.135655, 2.288295, 1.199886, 1.324101, 2.168863, 1.851523, NIL]
  END_DEFINE
  DIRECTION_DEFINE L8_1 REV L8_0
END_DEFINE

# ===== 换乘定义（类型引用） =====
# 大东门（1、2）—— 站厅换乘
TRANSFER HALL "大东门" L1 L2

# 合肥南站（1、4、5）—— 通道换乘（大型枢纽）
TRANSFER CHANNEL "合肥南站" L1 L4
TRANSFER CHANNEL "合肥南站" L4 L5
TRANSFER SAME "合肥南站" L1 L5

# 西七里塘（2、3）—— 节点换乘
TRANSFER STAIR "西七里塘" L2 L3

# 三孝口（2、5）—— 站厅换乘
TRANSFER HALL "三孝口" L2 L5

# 义城（7、5）—— 暂缓开通
TRANSFER PENDING "义城" L7 L5

# 朱岗（1、6）—— 节点换乘
TRANSFER STAIR "朱岗" L1 L6

# 卫岗（5、6）—— 节点换乘
TRANSFER STAIR "卫岗" L5 L6

# 方庙（3、4）—— 站厅换乘
TRANSFER HALL "方庙" L3 L4

# 图书馆（3、4）—— 站厅换乘
TRANSFER HALL "图书馆" L3 L4

# 海棠（3、5）—— 节点换乘
TRANSFER STAIR "海棠" L3 L5

# 一里井（3、8）—— 节点换乘
TRANSFER STAIR "一里井" L3 L8

# 杏林（5、8）—— 节点换乘
TRANSFER STAIR "杏林" L5 L8

# 北雁湖（4、6）—— 同台换乘
TRANSFER SAME "北雁湖" L4 L6

# 站点线路状态
STATION_STATUS '馆驿' L3 PENDING
STATION_STATUS '紫云湖' L4 PENDING
STATION_STATUS '市博物馆' L6 PENDING
STATION_STATUS '合肥四中' L7 PENDING
STATION_STATUS '义城' L7 PENDING

# ===== 运营时间 =====
OPEN_TIME GLOBAL 06:00 23:00

OPEN_TIME L1 06:00 23:30
OPEN_TIME L2 06:00 23:30
OPEN_TIME L3 06:00 23:00
OPEN_TIME L4 06:00 23:00
OPEN_TIME L5 06:00 23:00
OPEN_TIME L6 06:00 22:30
OPEN_TIME L7 06:00 22:30
OPEN_TIME L8 06:00 22:30

# 票价规则
PRICE_DEFINE
  DEFAULT_FARE 2.00
  SEGMENT 0.00 8.00 2.00
  SEGMENT 8.00 14.00 3.00
  SEGMENT 14.00 21.00 4.00
  SEGMENT 21.00 29.00 5.00
  LINEAR_EXTENSION THRESHOLD 29.00 BASE_FARE 5.00 RATE_PER_KM 0.111111
END_DEFINE
