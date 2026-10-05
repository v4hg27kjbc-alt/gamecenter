/**
 * 航空术语词典数据（术语解释服务的数据源）
 *
 * 说明：
 *   1) 本文件为**通用航空行业术语**的释义，属行业通用知识，不含任何机型专属参数；
 *   2) 机型专属参数（座位数、航程、发动机型号等）一律来自机型库（aircraft-index.js），
 *      术语服务禁止回答机型参数问题，遇到时由 /api/chat 走 RAG 通道；
 *   3) 每条术语包含：中文名、英文名/缩写、别名（检索用）、定义、常见误解、相关术语。
 *
 * 维护约定：新增术语直接追加到 GLOSSARY 数组，无需改动代码。
 */

export const GLOSSARY_META = {
  version: '1.0',
  updatedAt: '2026-09-26',
  count: 32,
  note: '通用航空术语释义；机型参数不在本词典范围内（见 RAG 机型库）'
};

export const GLOSSARY = [
  {
    term: 'MTOW',
    zh: '最大起飞重量',
    en: 'Maximum Take-Off Weight',
    aliases: ['最大起飞重量', 'MTOW', '最大起飞全重', '起飞全重'],
    definition: '飞机在起飞滑跑开始瞬间所允许的最大总重量，由结构强度、发动机推力、机翼升力与适航规章共同限定。它是划分飞机量级的关键指标，也是机场跑道承载与道面等级评估的重要输入。',
    misconception: 'MTOW 不是飞机的实际重量，实际起飞重量通常是 MTOW、最大着陆重量与业载需求三者中的最小值。',
    related: ['MLW', 'MZFW', 'OEW']
  },
  {
    term: 'MLW',
    zh: '最大着陆重量',
    en: 'Maximum Landing Weight',
    aliases: ['最大着陆重量', 'MLW'],
    definition: '飞机着陆接地瞬间允许的最大重量，主要受起落架与机体结构在接地冲击下的承载能力限制，一般明显小于最大起飞重量。',
    misconception: '起飞后若需立即返场，往往要先盘旋放油或将燃油消耗到 MLW 以下才能落地，并非“随时可以落”。',
    related: ['MTOW', 'OEW']
  },
  {
    term: 'OEW',
    zh: '使用空重',
    en: 'Operating Empty Weight',
    aliases: ['使用空重', 'OEW', '空机重量'],
    definition: '包含机体、发动机、标准设备、不可用燃油与机组及随身物品，但不含业载（旅客、货物、可用燃油）的重量。业载能力 = MTOW − OEW − 燃油重量。',
    misconception: 'OEW 不等于“裸机重量”，它包含机组、餐车、水箱等运行必需项。',
    related: ['MTOW', 'Payload']
  },
  {
    term: 'Payload',
    zh: '业载',
    en: 'Payload',
    aliases: ['业载', '有效载荷', '商载'],
    definition: '飞机一次飞行可用于产生收益的重量，通常指旅客（按标准人均重量折算）加行李与货物的总重量，不含燃油与机组。',
    misconception: '“载客量”与“业载”不是同一概念：前者是人数，后者是重量，两舱布局与全经济舱布局的差异主要体现在人数而非重量。',
    related: ['OEW', 'MTOW']
  },
  {
    term: 'Range',
    zh: '航程',
    en: 'Range',
    aliases: ['航程', '最大航程', 'range'],
    definition: '飞机在携带规定业载与燃油条件下能够飞行的距离。同一机型的航程会随业载、巡航高度、气象与备用油政策变化，厂商公布值通常标明对应的业载条件。',
    misconception: '“最大航程”通常对应减少业载或特定巡航条件的理想值，不能直接理解为满客满货时的实际可飞距离。',
    related: ['Ferry Range', 'ETOPS']
  },
  {
    term: 'Ferry Range',
    zh: '转场航程',
    en: 'Ferry Range',
    aliases: ['转场航程', '调机航程'],
    definition: '不载客、不载货，仅携带必要机组与燃油时的最大飞行距离，多用于调机、交付飞行或维修转运场景。',
    misconception: '转场航程数值远大于商业航程，不可用于宣传“载客能飞多远”。',
    related: ['Range']
  },
  {
    term: 'ETOPS',
    zh: '双发延程运行',
    en: 'Extended-range Twin-engine Operational Performance Standards',
    aliases: ['ETOPS', '双发延程', '延程运行', '双发延程运行'],
    definition: '针对双发飞机在远离备降机场航段上运行的适航与运行标准。取得 ETOPS 资质后，双发飞机可在距备降机场超过 60 分钟的航路上运行，常见等级有 120、180 分钟等。',
    misconception: 'ETOPS 不是一种发动机或机型型号，而是运行批准等级；同一机型不同航司的 ETOPS 等级可能不同。',
    related: ['Range', '适航认证']
  },
  {
    term: '适航认证',
    zh: '适航认证',
    en: 'Airworthiness Certification',
    aliases: ['适航认证', '适航证', '型号合格证', 'TC', 'CAAC', 'FAA', 'EASA'],
    definition: '由民航主管部门（如中国民航局 CAAC、美国 FAA、欧洲 EASA）依据适航规章对飞机设计、制造与持续运行状态进行的审查与批准，型号合格证（TC）批准设计，标准适航证批准单机运行。',
    misconception: '取得型号合格证不等于该机型已获所有国家准入，跨境运营通常还需对方当局的认可或独立审查。',
    related: ['ETOPS']
  },
  {
    term: 'V1',
    zh: '决断速度',
    en: 'Decision Speed',
    aliases: ['V1', '决断速度'],
    definition: '起飞滑跑中，一旦达到该速度，即使发生单发失效也必须继续起飞；在此之前发生故障则应中断起飞。V1 取决于重量、跑道长度、气温、气压高度与襟翼构型。',
    misconception: 'V1 不是“刹车速度上限”，它是机组决策分界点，须在每次起飞前按实际条件计算。',
    related: ['VR', 'V2', '减推力起飞']
  },
  {
    term: 'VR',
    zh: '抬前轮速度',
    en: 'Rotation Speed',
    aliases: ['VR', '抬前轮速度', '抬轮速度'],
    definition: '起飞滑跑中开始拉杆抬前轮、使飞机进入离地姿态的速度，通常略高于 V1。',
    misconception: '达到 VR 后抬轮过快会造成尾部擦地或过早离地失去加速能力，操作需平稳。',
    related: ['V1', 'V2']
  },
  {
    term: 'V2',
    zh: '安全起飞速度',
    en: 'Take-off Safety Speed',
    aliases: ['V2', '安全起飞速度'],
    definition: '单发失效时在 35 英尺高度必须达到的最小爬升速度，是起飞航迹能否满足越障要求的基准速度。',
    misconception: 'V2 不是离地速度，飞机离地速度通常低于 V2，随后加速到 V2。',
    related: ['V1', 'VR']
  },
  {
    term: 'Mach',
    zh: '马赫数',
    en: 'Mach Number',
    aliases: ['马赫数', '马赫', 'Mach', 'M数'],
    definition: '飞行速度与当地音速的比值。随高度升高气温下降，同一马赫数对应的真空速减小，因此高空巡航常以马赫数而非空速作为控制目标。',
    misconception: '“0.85 马赫”不是固定公里数，随高度与气温变化对应不同真空速。',
    related: ['巡航高度层', '超音速巡航']
  },
  {
    term: '巡航高度层',
    zh: '巡航高度层',
    en: 'Flight Level (FL)',
    aliases: ['巡航高度层', '飞行高度层', 'FL', '高度层'],
    definition: '以标准气压 1013.25 hPa 为基准的高度表示方式，如 FL350 表示 35,000 英尺。使用标准气压基准可保证所有航空器在高空使用统一的高度基准，实现垂直间隔管理。',
    misconception: '巡航高度层与“海拔高度”不同，过渡高度层以上不再使用当地气压修正。',
    related: ['Mach', '升限']
  },
  {
    term: '升限',
    zh: '升限',
    en: 'Service Ceiling',
    aliases: ['升限', '实用升限', 'ceiling', '最大升限'],
    definition: '飞机在标准条件下以规定爬升率（民用运输类常取 100 英尺/分钟）能够达到的最高高度，受发动机推力、机翼升力与增压系统能力限制。',
    misconception: '升限不是“飞不到就掉下来”的极限，而是可维持规定爬升率的高度上限，飞机仍有操纵余度。',
    related: ['巡航高度层', 'MTOW']
  },
  {
    term: '涵道比',
    zh: '涵道比',
    en: 'Bypass Ratio',
    aliases: ['涵道比', 'bypass ratio'],
    definition: '涡扇发动机中，绕过核心机的空气流量与进入核心机燃烧的空气流量之比。涵道比越高，推进效率与燃油经济性越好、噪声越低，但高速性能相对下降。',
    misconception: '涵道比高不等于推力大，高涵道比主要提升效率而非绝对推力。',
    related: ['涡扇发动机', '加力燃烧室']
  },
  {
    term: '涡扇发动机',
    zh: '涡扇发动机',
    en: 'Turbofan Engine',
    aliases: ['涡扇发动机', '涡扇', 'turbofan'],
    definition: '由核心机（压气机、燃烧室、涡轮）与风扇组成的燃气涡轮发动机，风扇推动的旁通气流提供主要推力，广泛用于现代民航客机与多数军用运输机。',
    misconception: '客机发动机并不“烧空气产生推力”，主要推力来自风扇加速的大量空气，核心机更多用于驱动风扇。',
    related: ['涵道比', '加力燃烧室']
  },
  {
    term: '加力燃烧室',
    zh: '加力燃烧室',
    en: 'Afterburner',
    aliases: ['加力燃烧室', '加力', 'afterburner', '后燃器'],
    definition: '在涡扇/涡喷发动机涡轮后再次喷油燃烧的装置，可短时显著提升推力，代价是耗油率激增，多用于战斗机起飞、加速与超音速冲刺。',
    misconception: '加力只能短时使用，通常有使用时长与飞行小时比例限制，不是常态巡航手段。',
    related: ['涡扇发动机', '超音速巡航']
  },
  {
    term: '超音速巡航',
    zh: '超音速巡航',
    en: 'Supercruise',
    aliases: ['超音速巡航', 'supercruise'],
    definition: '飞机在不使用加力燃烧室的情况下持续以超过音速的速度飞行，需具备低阻外形与足够的干推力，是部分新一代战斗机的标志性能力。',
    misconception: '短暂超音速与超音速巡航不同，前者依靠加力即可实现。',
    related: ['加力燃烧室', 'Mach']
  },
  {
    term: '电传操纵',
    zh: '电传操纵',
    en: 'Fly-By-Wire (FBW)',
    aliases: ['电传操纵', '电传', 'FBW', 'Fly-By-Wire'],
    definition: '用电子信号与计算机取代机械连杆传递操纵指令，飞行控制计算机按飞行包线对指令进行限制与增稳，可放宽静稳定性以提升气动效率。',
    misconception: '电传并不等于完全自动驾驶，飞行员仍是决策主体，系统主要在包线保护层面介入。',
    related: ['静稳定性', '飞行包线']
  },
  {
    term: '静稳定性',
    zh: '静稳定性',
    en: 'Static Stability',
    aliases: ['静稳定性', '静稳定', '静不稳定'],
    definition: '受扰动后飞机是否产生使自身回到原平衡状态的趋势。传统布局静稳定，现代战斗机常采用静不稳定设计以提升机动性，依靠电传系统持续增稳。',
    misconception: '静不稳定不等于不安全，前提是飞控系统具备足够可靠度（多重冗余）。',
    related: ['电传操纵', '飞行包线']
  },
  {
    term: '飞行包线',
    zh: '飞行包线',
    en: 'Flight Envelope',
    aliases: ['飞行包线', '包线', 'flight envelope'],
    definition: '飞机允许飞行的速度、高度、过载与姿态的组合范围，由结构强度、气动特性与发动机能力共同决定，超出包线意味着结构或操纵风险。',
    misconception: '包线不是“性能上限”，而是“安全边界”，性能数据通常取自包线内的特定条件。',
    related: ['电传操纵', '升限']
  },
  {
    term: '复合材料',
    zh: '复合材料',
    en: 'Composite Material (CFRP)',
    aliases: ['复合材料', '碳纤维', 'CFRP', '碳纤维复合材料'],
    definition: '以碳纤维等增强体与树脂基体复合而成的结构材料，比强度与抗疲劳性能优于铝合金，现代客机机翼与机身大量采用，可减重并降低腐蚀维护成本。',
    misconception: '复合材料并非“不会疲劳”，其损伤形式（分层、冲击损伤）与金属不同，需专门的无损检测手段。',
    related: ['涡扇发动机']
  },
  {
    term: '座舱高度',
    zh: '座舱高度',
    en: 'Cabin Altitude',
    aliases: ['座舱高度', '客舱增压', '座舱增压'],
    definition: '客舱增压后等效的海拔高度。巡航时通常维持在相当于 1,800–2,400 米的海拔压力，使乘客血氧水平保持在舒适范围。',
    misconception: '“座舱高度”不是飞机实际飞行高度，两者相差数千英尺；增压系统故障时的下降动作正是为了降低座舱高度。',
    related: ['巡航高度层']
  },
  {
    term: '雷达散射截面',
    zh: '雷达散射截面',
    en: 'Radar Cross Section (RCS)',
    aliases: ['雷达散射截面', 'RCS', '雷达反射面积'],
    definition: '目标在雷达波照射下等效反射面积的度量，数值越小越难被雷达发现。外形设计（如倾斜平面、内置弹舱）、吸波材料与进气道遮蔽是主要降低手段。',
    misconception: 'RCS 不是固定常数，随探测雷达频段与照射角度变化，通常以特定角度区间的量级描述。',
    related: ['隐身外形设计']
  },
  {
    term: '隐身外形设计',
    zh: '隐身外形设计',
    en: 'Low Observable Design',
    aliases: ['隐身外形设计', '隐身', '低可探测性'],
    definition: '通过控制外形棱线与平面走向，把雷达波反射能量导向少数方向，从而降低被雷达在特定角度发现的概率，常与内置武器舱、锯齿状舱门边缘配合使用。',
    misconception: '隐身不等于“完全看不见”，其效果具有角度与频段依赖性，通常表现为被发现距离显著缩短。',
    related: ['雷达散射截面']
  },
  {
    term: '翼展',
    zh: '翼展',
    en: 'Wingspan',
    aliases: ['翼展', 'wingspan'],
    definition: '机翼左右翼尖之间的水平距离。翼展越大，诱导阻力越小、巡航效率越高，但受机场跑道宽度、廊桥与机位限制。',
    misconception: '翼展不是“总宽度”，机身与翼尖小翼不计入方式需按厂商定义，比较时应取同一口径。',
    related: ['后掠翼']
  },
  {
    term: '后掠翼',
    zh: '后掠翼',
    en: 'Swept Wing',
    aliases: ['后掠翼', '后掠角'],
    definition: '机翼前缘向后倾斜的布局，可推迟高亚音速下激波的出现、提高临界马赫数，是喷气式客机与高速飞机的常规选择。',
    misconception: '后掠角越大不代表越快越好，后掠会降低低速升力效率并使翼尖先失速，需要复杂的增稳与翼尖处理。',
    related: ['翼展', 'Mach']
  },
  {
    term: 'APU',
    zh: '辅助动力装置',
    en: 'Auxiliary Power Unit',
    aliases: ['APU', '辅助动力装置'],
    definition: '机尾的小型燃气涡轮装置，在地面为主发动机起动提供气源与电源、为客舱供气，空中可作为应急电源来源。',
    misconception: 'APU 不提供推力，其作用是为系统供气供电与应急保障。',
    related: ['涡扇发动机']
  },
  {
    term: 'ILS',
    zh: '仪表着陆系统',
    en: 'Instrument Landing System',
    aliases: ['ILS', '仪表着陆系统', '盲降', 'CAT III', 'CATIII'],
    definition: '由航向道与下滑道信标构成的精密进近引导系统，配合机载设备可引导飞机在低能见度条件下对准跑道下降。按最低决断高与跑道视程分为 CAT I/II/III 等类别。',
    misconception: 'CAT III 不是机型能力标签，而是“机场设施 + 机载设备 + 机组资质”三者组合后才可实施的运行类别。',
    related: ['HUD', 'V1']
  },
  {
    term: 'ADS-B',
    zh: '广播式自动相关监视',
    en: 'Automatic Dependent Surveillance–Broadcast',
    aliases: ['ADS-B', '广播式自动相关监视'],
    definition: '航空器基于机载导航数据自动广播位置、高度、速度与识别信息的监视技术，地面站与邻近航空器可接收，是新一代空管监视体系的基础。',
    misconception: 'ADS-B 不是雷达的替代品的简单等价物，其数据依赖机载导航源，因此“相关”且需要完好性保障机制。',
    related: ['ILS']
  },
  {
    term: 'HUD',
    zh: '平视显示器',
    en: 'Head-Up Display',
    aliases: ['HUD', '平视显示器'],
    definition: '将飞行参数与引导符号投影到飞行员正前方透明显示屏上的设备，使飞行员在保持外部视线的情况下读取关键数据，常用于低能见度进近与起飞。',
    misconception: 'HUD 不代替机组判断，使用 HUD 实施低能见运行仍需相应的运行批准与训练。',
    related: ['ILS']
  },
  {
    term: '湿租',
    zh: '湿租',
    en: 'Wet Lease',
    aliases: ['湿租', 'wet lease', '干租', 'dry lease'],
    definition: '湿租指连同机组、维修与保险一并租入航空器，多用于旺季或临时运力补充；干租仅租航空器本体，机组与维修由承租人负责。',
    misconception: '湿租不改变运行责任主体，安全责任仍由实际运行方按批准运行规范承担。',
    related: ['代码共享']
  },
  {
    term: '代码共享',
    zh: '代码共享',
    en: 'Code Sharing',
    aliases: ['代码共享', 'code share'],
    definition: '两家或多家航司在同一航班上挂各自航班号、按协议分配座位与收益的合作方式，用于扩展航线网络。',
    misconception: '代码共享航班由实际承运人执飞，旅客所购航班号与执飞公司可能不一致，行李与改签规则按实际承运方与协议执行。',
    related: ['湿租']
  },
  {
    term: '客改货',
    zh: '客改货',
    en: 'Passenger-to-Freighter (P2F)',
    aliases: ['客改货', 'P2F', '货机改装'],
    definition: '将退役客机通过拆除客舱设施、加装主货舱门与货物装载系统改造为货机的工程，是高龄客机延长服役周期的常见路径。',
    misconception: '客改货不是简单拆除座椅，涉及结构加强、防火与地板承载等系统性适航改装。',
    related: ['适航认证']
  },
  {
    term: '减推力起飞',
    zh: '减推力起飞',
    en: 'Reduced Thrust Take-off',
    aliases: ['减推力起飞', 'flex 起飞', '灵活推力'],
    definition: '在跑道长度与越障能力允许时，使用低于最大推力的起飞推力设定，以降低发动机磨损与维修成本，需按当日重量、气温与跑道条件计算。',
    misconception: '减推力起飞必须以性能计算为前提，不是“为省油随意减小推力”。',
    related: ['V1', 'MTOW']
  }
];
