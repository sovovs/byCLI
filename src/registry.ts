/**
 * Core registry: Strategy enum, Arg/CliCommand interfaces, cli() registration.
 */

import type { IPage } from './types.js';
import { recordRegistryMutation, withRegistryMutationGroup } from './registry-transaction.js';

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
export type BrowserRequirementResolver = (args: CommandArgs) => boolean;
export type BrowserDeclaration = boolean | BrowserRequirementResolver;
export type NormalizedBrowserRequirement = boolean | 'conditional';
export type BrowserCommandFunc = (page: IPage, kwargs: CommandArgs, debug?: boolean) => Promise<unknown>;
export type ConditionalBrowserCommandFunc = (page: IPage | null, kwargs: CommandArgs, debug?: boolean) => Promise<unknown>;
export type NonBrowserCommandFunc = (kwargs: CommandArgs, debug?: boolean) => Promise<unknown>;
export type CommandAccess = 'read' | 'write';
export type SiteSessionMode = 'ephemeral' | 'persistent';

/**
 * 所有已注册 adapter command 的共享元数据和运行选项。
 *
 * 这里故意不包含 `browser` 和 `func` 这类执行形态字段，因为浏览器命令和
 * 非浏览器命令、条件浏览器命令的执行签名不同。`BrowserCliCommand`、
 * `NonBrowserCliCommand` 和 `ConditionalBrowserCliCommand` 会在 normalize 之后
 * 扩展这个共同底座，形成最终可执行的命令类型。
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
  /** Browser commands receive an IPage. */
  browser: true;
  func?: BrowserCommandFunc;
}

export interface NonBrowserCliCommand extends BaseCliCommand {
  /** Non-browser commands do not receive a page argument. */
  browser: false;
  func?: NonBrowserCommandFunc;
}

export interface ConditionalBrowserCliCommand extends BaseCliCommand {
  /** Browser use is resolved from the final command arguments at execution time. */
  browser: 'conditional';
  requiresBrowser: BrowserRequirementResolver;
  func?: ConditionalBrowserCommandFunc;
}

export type CliCommand = BrowserCliCommand | NonBrowserCliCommand | ConditionalBrowserCliCommand;

/**
 * `cli()` 注册 adapter 时使用的内部预归一化命令形态。
 *
 * adapter 作者传入的是 `CliOptions`，它的 TypeScript union 会保证公开调用点足够精确。
 * registry 内部会先把这些选项复制成对应的预归一化分支，再交给
 * `normalizeCommand()` 根据 `strategy` 推导 `browser`、`navigateBefore` 等运行时意图，
 * 最后存成具体的 `CliCommand`。
 */
type RawCliCommandBase = Omit<BaseCliCommand, 'strategy'>;

type RawBrowserCliCommand = RawCliCommandBase & { func?: BrowserCommandFunc } & (
  | { browser: true; strategy?: Strategy }
  | { browser?: true; strategy?: BrowserStrategy }
);

type RawNonBrowserCliCommand = RawCliCommandBase & { func?: NonBrowserCommandFunc } & (
  | { browser: false; strategy?: Strategy }
  | { browser?: false; strategy: Strategy.PUBLIC | Strategy.LOCAL }
);

type RawConditionalBrowserCliCommand = RawCliCommandBase & {
  browser: BrowserRequirementResolver;
  strategy?: Strategy;
  func?: ConditionalBrowserCommandFunc;
};

type RawCliCommand = RawBrowserCliCommand | RawNonBrowserCliCommand | RawConditionalBrowserCliCommand;

/** Internal extension for lazy-loaded TS modules (not exposed in public API) */
export type InternalCliCommand = CliCommand & {
  _lazy?: boolean;
  _modulePath?: string;
  _hydrateBeforeBrowserRouting?: boolean;
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
type ConditionalBrowserCliOptions = Partial<Omit<ConditionalBrowserCliCommand, 'args' | 'description' | 'browser' | 'requiresBrowser'>>
  & RequiredCliOptions
  & { browser: BrowserRequirementResolver };

export type CliOptions = BrowserCliOptions | NonBrowserCliOptions | ConditionalBrowserCliOptions;

// Use globalThis to ensure a single shared registry across all module instances.
// This is critical for TS plugins loaded via npm link / peerDependency — without
// this, the plugin's import creates a separate module instance with its own Map.
declare global { var __bycli_registry__: Map<string, CliCommand> | undefined; }
const _registry: Map<string, CliCommand> =
  globalThis.__bycli_registry__ ??= new Map<string, CliCommand>();

export function cli(opts: ConditionalBrowserCliOptions): ConditionalBrowserCliCommand;
export function cli(opts: NonBrowserCliOptions): NonBrowserCliCommand;
export function cli(opts: BrowserCliOptions): BrowserCliCommand;
export function cli(opts: CliOptions): CliCommand {
  const base = rawCommandBase(opts);
  let cmd: RawCliCommand;
  if (typeof opts.browser === 'function') {
    cmd = { ...base, strategy: opts.strategy, browser: opts.browser, func: opts.func };
  } else if (opts.browser === false) {
    cmd = { ...base, strategy: opts.strategy, browser: false, func: opts.func };
  } else if (opts.browser === true) {
    cmd = { ...base, strategy: opts.strategy, browser: true, func: opts.func };
  } else if (isImplicitNonBrowserOptions(opts)) {
    cmd = { ...base, strategy: opts.strategy, browser: opts.browser, func: opts.func };
  } else {
    cmd = { ...base, strategy: opts.strategy, browser: opts.browser, func: opts.func };
  }

  registerCommandInput(cmd);
  return _registry.get(fullName(cmd))!;
}

function rawCommandBase(opts: CliOptions): RawCliCommandBase {
  return {
    site: opts.site,
    name: opts.name,
    aliases: opts.aliases,
    description: opts.description ?? '',
    access: opts.access,
    example: opts.example,
    domain: opts.domain,
    args: opts.args ?? [],
    columns: opts.columns,
    pipeline: opts.pipeline,
    footerExtra: opts.footerExtra,
    validateArgs: opts.validateArgs,
    navigateBefore: opts.navigateBefore,
    siteSession: opts.siteSession,
    defaultFormat: opts.defaultFormat,
  };
}

function isImplicitNonBrowserOptions(
  opts: BrowserCliOptions | NonBrowserCliOptions,
): opts is NonBrowserCliOptions {
  return opts.browser === undefined
    && (opts.strategy === Strategy.PUBLIC || opts.strategy === Strategy.LOCAL);
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

/** Whether a command may use browser-backed execution for some invocation. */
export function hasBrowserCapability(cmd: CliCommand): boolean {
  return cmd.browser !== false;
}

/** Stable human-readable label for the normalized browser requirement. */
export function browserRequirementLabel(cmd: CliCommand): 'yes' | 'no' | 'conditional' {
  return cmd.browser === 'conditional' ? 'conditional' : cmd.browser ? 'yes' : 'no';
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
function normalizeCommand(cmd: RawCliCommand | BrowserCliCommand | NonBrowserCliCommand): CliCommand {
  const declaredBrowser = cmd.browser;
  const strategy = cmd.strategy ?? (declaredBrowser === false ? Strategy.PUBLIC : Strategy.COOKIE);

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

  if (typeof cmd.browser === 'function') {
    const normalized: ConditionalBrowserCliCommand = {
      ...cmd,
      strategy,
      browser: 'conditional',
      requiresBrowser: cmd.browser,
      navigateBefore,
    };
    return normalized;
  }

  if (cmd.browser === false) {
    const normalized: NonBrowserCliCommand = { ...cmd, strategy, browser: false, navigateBefore };
    return normalized;
  }

  if (cmd.browser === true) {
    const normalized: BrowserCliCommand = { ...cmd, strategy, browser: true, navigateBefore };
    return normalized;
  }

  if (isImplicitNonBrowserCommand(cmd)) {
    const normalized: NonBrowserCliCommand = { ...cmd, strategy, browser: false, navigateBefore };
    return normalized;
  }

  const normalized: BrowserCliCommand = { ...cmd, strategy, browser: true, navigateBefore };
  return normalized;
}

function isImplicitNonBrowserCommand(
  cmd: RawBrowserCliCommand | RawNonBrowserCliCommand,
): cmd is RawNonBrowserCliCommand {
  return cmd.browser === undefined
    && (cmd.strategy === Strategy.PUBLIC || cmd.strategy === Strategy.LOCAL);
}

function assertCommandAccess(cmd: Pick<BaseCliCommand, 'site' | 'name'> & { access?: unknown }): void {
  if (cmd.access === 'read' || cmd.access === 'write') return;
  const key = `${cmd.site}/${cmd.name}`;
  throw new Error(`Command ${key} must declare access: 'read' | 'write'`);
}

function assertSiteSession(cmd: Pick<BaseCliCommand, 'site' | 'name'> & { siteSession?: unknown }): void {
  if (cmd.siteSession === undefined) return;
  const key = `${cmd.site}/${cmd.name}`;
  if (cmd.siteSession !== 'ephemeral' && cmd.siteSession !== 'persistent') {
    throw new Error(`Command ${key} siteSession must be one of: ephemeral, persistent`);
  }
}

export function registerCommand(cmd: RawConditionalBrowserCliCommand): void;
export function registerCommand(cmd: RawNonBrowserCliCommand): void;
export function registerCommand(cmd: RawBrowserCliCommand): void;
export function registerCommand(cmd: CliCommand): void;
export function registerCommand(cmd: RawCliCommand | CliCommand): void {
  registerCommandInput(cmd);
}

function registerCommandInput(cmd: RawCliCommand | CliCommand): void {
  withRegistryMutationGroup(() => {
    assertCommandAccess(cmd);
    assertSiteSession(cmd);

    if (cmd.browser === 'conditional') {
      if (typeof cmd.requiresBrowser !== 'function') {
        const key = `${cmd.site}/${cmd.name}`;
        throw new Error(`Command ${key} requiresBrowser must be a function`);
      }
      insertNormalizedCommand(cmd);
      return;
    }

    insertNormalizedCommand(normalizeCommand(cmd));
  });
}

function setRegistryValue(key: string, value: CliCommand): void {
  const before = { present: _registry.has(key), value: _registry.get(key) };
  recordRegistryMutation(key, before, { present: true, value });
  _registry.set(key, value);
}

function deleteRegistryValue(key: string): void {
  const before = { present: _registry.has(key), value: _registry.get(key) };
  if (!before.present) return;
  recordRegistryMutation(key, before, { present: false, value: undefined });
  _registry.delete(key);
}

function insertNormalizedCommand(normalized: CliCommand): void {
  const canonicalKey = fullName(normalized);
  const existing = _registry.get(canonicalKey);
  if (existing?.aliases) {
    for (const alias of existing.aliases) {
      deleteRegistryValue(`${existing.site}/${alias}`);
    }
  }

  const aliases = normalizeAliases(normalized.aliases, normalized.name);
  normalized.aliases = aliases.length > 0 ? aliases : undefined;
  setRegistryValue(canonicalKey, normalized);
  for (const alias of aliases) {
    setRegistryValue(`${normalized.site}/${alias}`, normalized);
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
