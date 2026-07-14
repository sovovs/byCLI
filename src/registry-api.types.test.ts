import { describe, expectTypeOf, it } from 'vitest';
import { cli, registerCommand, Strategy } from './registry-api.js';
import type {
  BrowserCliCommand,
  CommandArgs,
  ConditionalBrowserCliCommand,
  NonBrowserCliCommand,
} from './registry.js';
import type { IPage } from './types.js';

describe('registry public TypeScript API', () => {
  it('contextually types callbacks and returns precise normalized branches', () => {
    const conditional = cli({
      site: 'types',
      name: 'conditional',
      access: 'read',
      browser: (args) => {
        expectTypeOf(args).toEqualTypeOf<CommandArgs>();
        return args['auth-source'] !== 'env';
      },
      func: async (page, args) => {
        expectTypeOf(page).toEqualTypeOf<IPage | null>();
        expectTypeOf(args).toEqualTypeOf<CommandArgs>();
        return [];
      },
    });
    const nonBrowser = cli({
      site: 'types',
      name: 'non-browser',
      access: 'read',
      browser: false,
      func: async (args) => {
        expectTypeOf(args).toEqualTypeOf<CommandArgs>();
        return [];
      },
    });
    const browser = cli({
      site: 'types',
      name: 'browser',
      access: 'read',
      browser: true,
      func: async (page, args) => {
        expectTypeOf(page).toEqualTypeOf<IPage>();
        expectTypeOf(args).toEqualTypeOf<CommandArgs>();
        return [];
      },
    });

    expectTypeOf(conditional).toEqualTypeOf<ConditionalBrowserCliCommand>();
    expectTypeOf(nonBrowser).toEqualTypeOf<NonBrowserCliCommand>();
    expectTypeOf(browser).toEqualTypeOf<BrowserCliCommand>();

    registerCommand(conditional);
    registerCommand({
      site: 'types',
      name: 'raw-conditional',
      access: 'read',
      description: '',
      args: [],
      browser: (_args: CommandArgs) => true,
      func: async (_page: IPage | null, _args: CommandArgs) => [],
    });
  });
});

function compileTimeNegativeCases(): void {
  // @ts-expect-error non-browser declarations cannot use a page-bearing function
  cli({ site: 'types', name: 'bad-non-browser', access: 'read', browser: false, func: async (_page: IPage, _args: CommandArgs) => [] });

  // @ts-expect-error conditional declarations must accept a nullable page
  cli({ site: 'types', name: 'bad-conditional', access: 'read', browser: () => true, func: async (_page: IPage, _args: CommandArgs) => [] });

  // @ts-expect-error static browser declarations require a page-bearing function
  cli({ site: 'types', name: 'bad-browser', access: 'read', browser: true, func: async (_page: number) => [] });

  // @ts-expect-error raw non-browser registrations cannot use a page-bearing function
  registerCommand({ site: 'types', name: 'bad-raw-non-browser', access: 'read', description: '', args: [], browser: false, func: async (_page: IPage, _args: CommandArgs) => [] });

  // @ts-expect-error raw conditional registrations must accept a nullable page
  registerCommand({ site: 'types', name: 'bad-raw-conditional', access: 'read', description: '', args: [], browser: () => true, func: async (_page: IPage, _args: CommandArgs) => [] });

  // @ts-expect-error raw static browser registrations require a page-bearing function
  registerCommand({ site: 'types', name: 'bad-raw-browser', access: 'read', description: '', args: [], browser: true, func: async (_page: number) => [] });
}

void compileTimeNegativeCases;
