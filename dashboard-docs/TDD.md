# 软件系统开发核心关注维度（技术内建篇）

> 本大纲聚焦于代码与架构层面，假定基础设施（容器、网络、监控）由平台层兜底，重点解决“如何写出更健壮、更易维护的业务代码”。

## 1. 核心铁三角（基线）
- **1.1 可行性（Technical Feasibility）**
  - 技术选型与团队能力匹配度
  - 关键难点（如高并发锁、分布式事务）的POC验证
- **1.2 可迭代性（Iterability）**
  - 代码低耦合，支持敏捷交付
  - 业务逻辑与基础设施解耦（Domain层独立）
- **1.3 可扩展性（Scalability）**
  - 预留扩展点（策略模式、SPI机制）
  - 无状态设计，支持水平扩展

## 2. SOLID 设计原则（架构基石）
> 面向对象/模块设计的五项基本原则，是代码可维护性与可扩展性的底层逻辑。

- **2.1 S - 单一职责原则（Single Responsibility）**
  - 一个类/模块只对一个角色（Actor）负责
  - 落地实践：拆分臃肿的“上帝类”（如 `OrderService` 拆分为 `OrderValidator`、`OrderPriceCalculator`、`OrderStateMachine`）
  - 判定标准：描述类职责时，是否只能用“且（and）”连接多个动词
- **2.2 O - 开闭原则（Open/Closed）**
  - 对扩展开放，对修改关闭
  - 落地实践：使用策略模式（Strategy）、模板方法模式（Template Method）处理多变的业务规则（如不同的折扣计算）；使用事件监听机制（Event/Listener）解耦核心流程与扩展逻辑
  - 判定标准：新增一种业务类型时，是否不需要修改已有的核心类，只需新增实现类
- **2.3 L - 里氏替换原则（Liskov Substitution）**
  - 子类必须能完全替换父类，且不破坏程序正确性
  - 落地实践：**优先使用组合（Composition）而非继承（Inheritance）**；子类重写父类方法时，不缩小父类的前置条件（入参），不放大后置条件（出参/异常）
  - 判定标准：将子类强转为父类后，业务逻辑是否依然完全正常运行
- **2.4 I - 接口隔离原则（Interface Segregation）**
  - 不应强迫客户端依赖它不需要的接口方法
  - 落地实践：避免“胖接口”（如一个 `OrderRepository` 有 20 个方法），按业务维度拆分为细粒度接口（如 `OrderQueryPort`、`OrderCommandPort`、`OrderStatisticsPort`）
  - 判定标准：实现类是否被迫实现了“空方法”或抛出 `UnsupportedOperationException`
- **2.5 D - 依赖倒置原则（Dependency Inversion）**
  - 高层模块不应依赖低层模块，二者都应依赖抽象；抽象不应依赖细节，细节应依赖抽象
  - 落地实践：严格遵循**六边形架构**，核心领域层定义接口（Port），基础设施层（如MySQL、Redis、MQ）实现接口（Adapter）
  - 判定标准：核心业务代码（Domain/Service）中是否没有任何 `import` 具体数据库驱动、第三方SDK的语句

## 3. 代码质量与可测试性（Testability）
- **3.1 单元测试覆盖度**
  - 核心领域逻辑（Util/Service）覆盖率 > 80%
  - 测试不依赖外部环境（数据库/中间件Mock化）
- **3.2 依赖注入与接口隔离**
  - 面向接口编程，方便替换实现类（呼应 SOLID 中的 D 和 I）
  - 严格控制静态方法和工具类的滥用
- **3.3 测试数据工厂**
  - 统一构造测试数据（Object Mother / Builder模式）

## 4. 接口契约与版本管理（Contract Management）
- **4.1 契约优先（Contract-First）**
  - 严格定义 OpenAPI / GraphQL / Protobuf
  - 字段校验逻辑（Bean Validation）写在接口层
- **4.2 向后兼容（Backward Compatibility）**
  - 接口字段只增不减，不改类型（遵循Google API Design Guide）
  - 破坏性变更强制升级主版本号（SemVer）
- **4.3 防腐层（Anti-Corruption Layer）**
  - 外部依赖变更时，内部通过适配器隔离，避免大面积改核心代码

## 5. 异常处理与业务语义（Error Handling）
- **5.1 统一异常码体系**
  - 区分系统异常（500）与业务异常（400+）
  - 业务异常需包含领域上下文（如：余额不足、库存锁定失败）
- **5.2 异常分层处理**
  - **Controller层**：全局异常拦截与格式化
  - **Service层**：抛出业务异常，不处理技术异常（由框架兜底）
- **5.3 事务与补偿**
  - 明确声明式事务（@Transactional）边界
  - 设计本地重试机制（Retry）或逆向补偿接口（Compensate）

## 6. 架构分层与依赖治理（Dependency Governance）
- **6.1 严格的分层架构**
  - 示例：Controller -> Application -> Domain -> Infrastructure
  - 禁止下层依赖上层，禁止跨层调用
- **6.2 循环依赖检测**
  - 利用 ArchUnit 编写架构单元测试，CI阶段拦截循环依赖
- **6.3 依赖包精简**
  - 排除冗余传递依赖（如 Logback 冲突、Guava 版本冲突）
  - 统一核心公用版本（Dependency Management）

## 7. 配置管理与特性开关（Configuration & Feature Flag）
- **7.1 环境配置隔离**
  - `application-{env}.yml` 分离（dev/test/prod）
- **7.2 业务配置外置化**
  - 硬编码零容忍（如 `if(amount > 1000)` 必须放入配置中心）
- **7.3 发布策略支持**
  - 引入 Feature Toggle（特性开关），支持灰度发布和 A/B Test
  - 配置变更支持热更新（RefreshScope）

## 8. 数据一致性处理（Data Consistency）
- **8.1 数据库设计规范**
  - 必须包含：`id`, `create_time`, `update_time`, `version`（乐观锁）
  - 逻辑删除字段（`is_deleted`）而非物理删除
- **8.2 分布式数据策略**
  - **强一致性**：采用 Seata（AT/TCC）或基于业务状态的补偿
  - **最终一致性**：本地消息表 + 定时任务轮询 或 RocketMQ 事务消息

## 9. 日志追踪与开发调试性（Logging & Debug）
- **9.1 日志级别动态控制**
  - 生产环境支持动态调整日志级别（如 Arthas/Logback）
- **9.2 链路追踪标识**
  - 必须打印 `TraceId` 或 `RequestId` 贯穿全流程（MDC.put）
- **9.3 敏感信息脱敏**
  - 日志中自动过滤密码、身份证号、手机号（通过脱敏工具类）

## 10. 开发规范与团队协作（Standards）
- **10.1 代码规约扫描**
  - 集成 SonarQube / Alibaba Java Coding Guidelines（P3C）
  - 阻断性问题（Blocker）必须清零才能合并
- **10.2 分支管理模型**
  - 采用 Git Flow 或 Trunk-Based Development
  - PR/MR 必须有 CR（Code Review）记录
- **10.3 架构决策记录（ADR）**
  - 记录关键设计决策及背景（Why），而非仅描述功能（What）