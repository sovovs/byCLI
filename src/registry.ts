/**
 * Core registry: Strategy enum, Arg/CliCommand interfaces, cli() registration.
 */

import type { IPage } from './types.js';

export enum Strategy {
  PUBLIC = 'public',
  LOCAL = 'local',
  COOKIE = 'cookie',
  INTERCEPT = 'intercept',
  UI = 'ui',
}

export interface Arg {
  name: string;
  type?: string;
  default?: unknown;
  required?: boolean;
  valueRequired?: boolean;
  positional?: boolean;
  help?: string;
  choices?: string[];
}

export type CommandArgs = Record<string, any>;
export type BrowserCommandFunc = (page: IPage, kwargs: CommandArgs, debug?: boolean) => Promise<unknown>;
export type NonBrowserCommandFunc = (kwargs: CommandArgs, debug?: boolean) => Promise<unknown>;
export type CommandAccess = 'read' | 'write';
export type SiteSessionMode = 'ephemeral' | 'persistent';

/**
 * 所有已注册 adapter command 的共享元数据和运行选项。
 *
 * 这里故意不包含 `browser` 和 `func` 这类执行形态字段，因为浏览器命令和
 * 非浏览器命令的执行签名不同。`BrowserCliCommand` 和 `NonBrowserCliCommand`
 * 会在 normalize 之后扩展这个共同底座，形成最终可执行的命令类型。
 */
interface BaseCliCommand {
  /** 站点或命名空间名称，对应命令中的 `<site>`，例如 `devto`、`brave`。 */
  site: string;
  /** 站点下的命令名称，对应命令中的 `<command>`，例如 `search`、`tag`。 */
  name: string;
  /** 当前命令的别名；注册时会映射到同一个命令对象。 */
  aliases?: string[];
  /** 命令说明，用于 help、list 和 agent-facing 输出。 */
  description: string;
  /** 命令访问类型：`read` 表示只读，`write` 表示会产生写操作或副作用。 */
  access: CommandAccess;
  /** 展示给 agent 的规范调用示例；省略时由帮助系统按命令信息生成。 */
  example?: string;
  /** 命令目标站点的域名，常用于 COOKIE strategy 的预导航。 */
  domain?: string;
  /** 命令策略，决定默认是否需要浏览器、cookie、拦截或 UI 自动化。 */
  strategy?: Strategy;
  /** 命令参数定义，Commander 会据此注册位置参数和选项。 */
  args: Arg[];
  /** 输出列顺序；渲染 table、csv、md 等格式时会按这个顺序展示字段。 */
  columns?: string[];
  /** 声明式执行流水线；没有 `func` 时由 pipeline executor 逐步执行。 */
  pipeline?: Record<string, unknown>[];
  /** 命令来源标识，例如历史格式、TS/JS 模块或插件名称。 */
  source?: string;
  /** 输出底部的额外说明，渲染阶段会用最终参数调用它。 */
  footerExtra?: (kwargs: CommandArgs) => string | undefined;
  /** adapter 自定义参数校验函数，在命令执行前运行。 */
  validateArgs?: (kwargs: CommandArgs) => void;
  /**
   * 控制执行前是否需要预导航，以及如何表达浏览器 session 需求。
   *
   * `normalizeCommand()` 展开 strategy 之后，这个字段会承载解析后的运行意图：
   *
   * - `undefined`：不预导航，是否需要浏览器由 pipeline step 决定
   * - `false`：明确跳过预导航，由 adapter 自己处理页面跳转
   * - `true`：需要已认证的浏览器上下文，但没有指定预导航 URL
   *   （例如 INTERCEPT/UI adapter，或没有 domain 的 COOKIE adapter）
   * - `string`：执行 adapter 前先导航到这个 URL
   *   （例如带 domain 的 COOKIE strategy 会生成 `https://<domain>`）
   *
   * adapter 作者可以显式设置它，用来覆盖基于 strategy 推导出的默认值。
   */
  navigateBefore?: boolean | string;
  /** adapter 浏览器站点 session 生命周期：临时 session 或持久 session。 */
  siteSession?: SiteSessionMode;
  /** 用户没有传 `-f/--format` 时使用的默认输出格式。 */
  defaultFormat?: 'table' | 'plain' | 'json' | 'yaml' | 'yml' | 'md' | 'markdown' | 'csv';
}

export interface BrowserCliCommand extends BaseCliCommand {
  /** Browser commands receive an IPage. Omitted means true after normalization. */
  browser?: true;
  func?: BrowserCommandFunc;
}

export interface NonBrowserCliCommand extends BaseCliCommand {
  /** Non-browser commands do not receive a page argument. */
  browser: false;
  func?: NonBrowserCommandFunc;
}

export type CliCommand = BrowserCliCommand | NonBrowserCliCommand;

/**
 * `cli()` 注册 adapter 时使用的内部预归一化命令形态。
 *
 * adapter 作者传入的是 `CliOptions`，它的 TypeScript union 会保证公开调用点足够精确。
 * registry 内部会先把这些选项复制成这个更宽松的形态，再交给 `normalizeCommand()`
 * 根据 `strategy` 推导 `browser`、`navigateBefore` 等运行时意图，最后存成具体的
 * `CliCommand`。
 */
type RawCliCommand = BaseCliCommand & {
  /** 预归一化阶段的浏览器需求标记；可省略，之后会由 strategy 推导。 */
  browser?: boolean;
  /** 预归一化阶段的执行函数；可能是浏览器签名，也可能是非浏览器签名。 */
  func?: BrowserCommandFunc | NonBrowserCommandFunc;
};

/** Internal extension for lazy-loaded TS modules (not exposed in public API) */
export type InternalCliCommand = CliCommand & {
  _lazy?: boolean;
  _modulePath?: string;
};

type RequiredCliOptions = {
  site: string;
  name: string;
  access: CommandAccess;
  description?: string;
  args?: Arg[];
};

type BrowserStrategy = Exclude<Strategy, Strategy.PUBLIC | Strategy.LOCAL>;
type BrowserCliOptions = Partial<Omit<BrowserCliCommand, 'args' | 'description' | 'browser' | 'strategy'>> & RequiredCliOptions & (
  | { browser: true; strategy?: Strategy }
  | { browser?: true; strategy?: BrowserStrategy }
);
type NonBrowserCliOptions = Partial<Omit<NonBrowserCliCommand, 'args' | 'description'>> & RequiredCliOptions & (
  | { browser: false }
  | { strategy: Strategy.PUBLIC | Strategy.LOCAL; browser?: false }
);

export type CliOptions = BrowserCliOptions | NonBrowserCliOptions;

// Use globalThis to ensure a single shared registry across all module instances.
// This is critical for TS plugins loaded via npm link / peerDependency — without
// this, the plugin's import creates a separate module instance with its own Map.
declare global { var __bycli_registry__: Map<string, CliCommand> | undefined; }
const _registry: Map<string, CliCommand> =
  globalThis.__bycli_registry__ ??= new Map<string, CliCommand>();

export function cli(opts: CliOptions): CliCommand {
  const cmd: RawCliCommand = {
    site: opts.site,
    name: opts.name,
    aliases: opts.aliases,
    description: opts.description ?? '',
    access: opts.access,
    example: opts.example,
    domain: opts.domain,
    strategy: opts.strategy,
    browser: opts.browser,
    args: opts.args ?? [],
    columns: opts.columns,
    func: opts.func,
    pipeline: opts.pipeline,
    footerExtra: opts.footerExtra,
    validateArgs: opts.validateArgs,
    navigateBefore: opts.navigateBefore,
    siteSession: opts.siteSession,
    defaultFormat: opts.defaultFormat,
  };

  registerCommand(cmd);
  return _registry.get(fullName(cmd))!;
}

export function getRegistry(): Map<string, CliCommand> {
  return _registry;
}

export function fullName(cmd: Pick<BaseCliCommand, 'site' | 'name'>): string {
  return `${cmd.site}/${cmd.name}`;
}

export function strategyLabel(cmd: CliCommand): string {
  return cmd.strategy ?? Strategy.PUBLIC;
}

/**
 * Normalize a command's runtime fields. This is the single place where
 * `strategy` is decoded into the concrete fields that the execution path
 * reads (`browser`, `navigateBefore`). After normalization, execution code
 * (resolvePreNav, shouldUseBrowserSession) never reads `cmd.strategy`.
 *
 * `strategy` itself is preserved as metadata for `bycli list`, cascade
 * probe, adapter generation, and human documentation.
 *
 * Override priority (highest wins):
 *   1. Explicit field on the command (`browser: false`, `navigateBefore: false`)
 *   2. Derived from strategy + domain (the defaults below)
 */
function normalizeCommand(cmd: RawCliCommand): CliCommand {
  assertCommandAccess(cmd);
  assertSiteSession(cmd);

  const strategy = cmd.strategy ?? (cmd.browser === false ? Strategy.PUBLIC : Strategy.COOKIE);
  const browser = cmd.browser ?? (strategy !== Strategy.PUBLIC && strategy !== Strategy.LOCAL);

  let navigateBefore = cmd.navigateBefore;
  if (navigateBefore === undefined) {
    if (strategy === Strategy.COOKIE && cmd.domain) {
      navigateBefore = `https://${cmd.domain}`;
    } else if (strategy !== Strategy.PUBLIC && strategy !== Strategy.LOCAL) {
      // Non-PUBLIC without domain: needs authenticated browser context
      // but no specific pre-navigation URL. `true` signals this to
      // shouldUseBrowserSession without triggering resolvePreNav.
      navigateBefore = true;
    }
  }

  return browser
    ? { ...cmd, strategy, browser: true, navigateBefore } as BrowserCliCommand
    : { ...cmd, strategy, browser: false, navigateBefore } as NonBrowserCliCommand;
}

function assertCommandAccess(cmd: Pick<RawCliCommand, 'site' | 'name'> & { access?: unknown }): asserts cmd is RawCliCommand {
  if (cmd.access === 'read' || cmd.access === 'write') return;
  const key = `${cmd.site}/${cmd.name}`;
  throw new Error(`Command ${key} must declare access: 'read' | 'write'`);
}

function assertSiteSession(cmd: Pick<RawCliCommand, 'site' | 'name'> & { siteSession?: unknown }): void {
  if (cmd.siteSession === undefined) return;
  const key = `${cmd.site}/${cmd.name}`;
  if (cmd.siteSession !== 'ephemeral' && cmd.siteSession !== 'persistent') {
    throw new Error(`Command ${key} siteSession must be one of: ephemeral, persistent`);
  }
}

export function registerCommand(cmd: RawCliCommand): void {
  const normalized = normalizeCommand(cmd);
  const canonicalKey = fullName(normalized);
  const existing = _registry.get(canonicalKey);
  if (existing?.aliases) {
    for (const alias of existing.aliases) {
      _registry.delete(`${existing.site}/${alias}`);
    }
  }

  const aliases = normalizeAliases(normalized.aliases, normalized.name);
  normalized.aliases = aliases.length > 0 ? aliases : undefined;
  _registry.set(canonicalKey, normalized);
  for (const alias of aliases) {
    _registry.set(`${normalized.site}/${alias}`, normalized);
  }
}

function normalizeAliases(aliases: string[] | undefined, commandName: string): string[] {
  if (!Array.isArray(aliases) || aliases.length === 0) return [];

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const alias of aliases) {
    const value = typeof alias === 'string' ? alias.trim() : '';
    if (!value || value === commandName || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}
