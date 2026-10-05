/**
 * 预生成（预热）问题集
 *
 * 用途：/api/prewarm 按本清单顺序为高频问题生成答案，写入 KV 并同步写入
 *       请求指纹缓存，使前台用户提出相同问题时**直接命中缓存**，不产生上游调用。
 *
 * 字段：
 *   id       唯一标识（KV 键的一部分，勿随意改动，改动会导致已预热内容失配）
 *   q        用户提问原文（缓存指纹按该文本归一化后计算，须与前台实际提问一致）
 *   feature  归属功能（用于日志与成本核算分组）
 *   tier     建议档位（light / flagship）
 *   rag      是否走知识锚定（机型相关问题必须为 true，禁止模型自行编造机型参数）
 *   note     备注（说明该问题为什么高频）
 *
 * 红线：预生成答案同样受 RAG 约束——库内无记录的机型参数必须回答“库内无记录”，
 *       不得因为“预热”而放松事实性要求。
 */

export const PREWARM_META = {
  version: '1.0',
  updatedAt: '2026-09-26',
  count: 14,
  note: '高频问题预生成清单；答案由模型基于机型库生成，写入 KV 与指纹缓存'
};

export const PREWARM_QUESTIONS = [
  {
    id: 'site-aircraft-count',
    q: '站内一共收录了多少款机型？',
    feature: 'prewarm',
    tier: 'light',
    rag: true,
    note: '新访客最常见的入口问题，答案完全由机型库计数得出'
  },
  {
    id: 'site-civil-list',
    q: '站内收录了哪些民航客机？',
    feature: 'prewarm',
    tier: 'light',
    rag: true,
    note: '导览类高频问题，答案可由机型库列表直接生成'
  },
  {
    id: 'site-largest-airliner',
    q: '站内收录的机型里，体型最大的是哪一款？',
    feature: 'prewarm',
    tier: 'light',
    rag: true,
    note: '对比类高频问题，必须按机型库参数回答，禁止凭印象作答'
  },
  {
    id: 'term-etops',
    q: '什么是 ETOPS？为什么双发飞机能飞越太平洋？',
    feature: 'prewarm',
    tier: 'light',
    rag: false,
    note: '术语类高频问题，走术语词典 + 模型解释'
  },
  {
    id: 'term-mach-fl',
    q: '马赫数和飞行高度层有什么关系？',
    feature: 'prewarm',
    tier: 'light',
    rag: false,
    note: '术语组合问题，术语词典覆盖'
  },
  {
    id: 'term-v1',
    q: '起飞时的 V1、VR、V2 分别代表什么？',
    feature: 'prewarm',
    tier: 'light',
    rag: false,
    note: '术语类高频问题，术语词典覆盖'
  },
  {
    id: 'compare-widebody',
    q: '双发宽体机和四发宽体机在运营上有什么区别？',
    feature: 'prewarm',
    tier: 'flagship',
    rag: true,
    note: '需要站内机型举例，属旗舰档'
  },
  {
    id: 'term-composite',
    q: '客机为什么大量使用复合材料？',
    feature: 'prewarm',
    tier: 'light',
    rag: false,
    note: '科普类高频问题'
  },
  {
    id: 'term-ils',
    q: 'ILS 盲降和 CAT III 是什么关系？',
    feature: 'prewarm',
    tier: 'light',
    rag: false,
    note: '术语类高频问题'
  },
  {
    id: 'site-photo-search',
    q: '怎么用照片识别飞机型号？',
    feature: 'prewarm',
    tier: 'light',
    rag: false,
    note: '站内功能引导类高频问题'
  },
  {
    id: 'site-compare-guide',
    q: '站内怎么对比两款机型的参数？',
    feature: 'prewarm',
    tier: 'light',
    rag: false,
    note: '站内功能引导类高频问题'
  },
  {
    id: 'term-stealth',
    q: '隐身飞机是怎么降低被雷达发现的概率的？',
    feature: 'prewarm',
    tier: 'flagship',
    rag: false,
    note: '科普类问题，涉及外形与材料，走旗舰档'
  },
  {
    id: 'term-cabin-altitude',
    q: '坐飞机时客舱高度是什么意思？',
    feature: 'prewarm',
    tier: 'light',
    rag: false,
    note: '体验类高频问题'
  },
  {
    id: 'site-unknown-check',
    q: '站内收录了波音 797 吗？',
    feature: 'prewarm',
    tier: 'light',
    rag: true,
    note: '负向校验用例：机型库无该机型，正确回答必须是“库内无记录”，不得编造'
  }
];
