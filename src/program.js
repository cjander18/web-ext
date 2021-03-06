/* @flow */
import path from 'path';
import {readFileSync} from 'fs';
import yargs from 'yargs';

import defaultCommands from './cmd';
import {UsageError} from './errors';
import {createLogger, consoleStream as defaultLogStream} from './util/logger';

const log = createLogger(__filename);
const envPrefix = 'WEB_EXT';


/*
 * The command line program.
 */
export class Program {
  yargs: any;
  commands: { [key: string]: Function };
  shouldExitProgram: boolean;

  constructor(
    argv: ?Array<string>,
    {absolutePackageDir = process.cwd()}: {absolutePackageDir?: string} = {}
  ) {
    // This allows us to override the process argv which is useful for
    // testing.
    // NOTE: process.argv.slice(2) removes the path to node and web-ext
    // executables from the process.argv array.
    argv = argv || process.argv.slice(2);

    // NOTE: always initialize yargs explicitly with the package dir
    // so that we are sure that it is going to load the 'boolean-negation: false'
    // config (See web-ext#469 for rationale).
    const yargsInstance = yargs(argv, absolutePackageDir);

    this.shouldExitProgram = true;
    this.yargs = yargsInstance;
    this.yargs.strict();

    this.commands = {};
  }

  command(name: string, description: string, executor: Function,
          commandOptions: Object = {}): Program {
    this.yargs.command(name, description, (yargs) => {
      if (!commandOptions) {
        return;
      }
      return yargs
        .demand(0, 0, 'This command does not take any arguments')
        .strict()
        .exitProcess(this.shouldExitProgram)
        // Calling env() will be unnecessary after
        // https://github.com/yargs/yargs/issues/486 is fixed
        .env(envPrefix)
        .options(commandOptions);
    });
    this.commands[name] = executor;
    return this;
  }

  setGlobalOptions(options: Object): Program {
    // This is a convenience for setting global options.
    // An option is only global (i.e. available to all sub commands)
    // with the `global` flag so this makes sure every option has it.
    Object.keys(options).forEach((key) => {
      options[key].global = true;
      if (options[key].demand === undefined) {
        // By default, all options should be "demanded" otherwise
        // yargs.strict() will think they are missing when declared.
        options[key].demand = true;
      }
    });
    this.yargs.options(options);
    return this;
  }

  async run(absolutePackageDir: string,
      {systemProcess = process, logStream = defaultLogStream,
       getVersion = defaultVersionGetter, shouldExitProgram = true}
      : Object = {}): Promise<void> {

    this.shouldExitProgram = shouldExitProgram;
    this.yargs.exitProcess(this.shouldExitProgram);

    const argv = this.yargs.argv;
    const cmd = argv._[0];

    let runCommand = this.commands[cmd];

    if (argv.verbose) {
      log.info('Version:', getVersion(absolutePackageDir));
      logStream.makeVerbose();
    }

    try {
      if (cmd === undefined) {
        throw new UsageError('No sub-command was specified in the args');
      }
      if (!runCommand) {
        throw new UsageError(`Unknown command: ${cmd}`);
      }
      await runCommand(argv);
    } catch (error) {
      const prefix = cmd ? `${cmd}: ` : '';
      if (!(error instanceof UsageError) || argv.verbose) {
        log.error(`\n${prefix}${error.stack}\n`);
      }
      else {
        log.error(`\n${prefix}${error}\n`);
      }
      if (error.code) {
        log.error(`${prefix}Error code: ${error.code}\n`);
      }

      if (this.shouldExitProgram) {
        systemProcess.exit(1);
      } else {
        throw error;
      }
    }
  }
}


export function defaultVersionGetter(absolutePackageDir: string): string {
  let packageData: any = readFileSync(
    path.join(absolutePackageDir, 'package.json'));
  return JSON.parse(packageData).version;
}


export function main(
    absolutePackageDir: string,
    {getVersion = defaultVersionGetter, commands = defaultCommands, argv,
     runOptions = {}}: Object = {}): Promise<any> {
  let program = new Program(argv, {absolutePackageDir});
  // yargs uses magic camel case expansion to expose options on the
  // final argv object. For example, the 'artifacts-dir' option is alternatively
  // available as argv.artifactsDir.
  program.yargs
    .usage(`Usage: $0 [options] command

Option values can also be set by declaring an environment variable prefixed
with $${envPrefix}_. For example: $${envPrefix}_SOURCE_DIR=/path is the same as
--source-dir=/path.

To view specific help for any given command, add the command name.
Example: $0 --help run.
`)
    .help('help')
    .alias('h', 'help')
    .env(envPrefix)
    .version(() => getVersion(absolutePackageDir))
    .demand(1)
    .strict();

  program.setGlobalOptions({
    'source-dir': {
      alias: 's',
      describe: 'Web extension source directory.',
      default: process.cwd(),
      requiresArg: true,
      type: 'string',
      coerce: path.resolve,
    },
    'artifacts-dir': {
      alias: 'a',
      describe: 'Directory where artifacts will be saved.',
      default: path.join(process.cwd(), 'web-ext-artifacts'),
      normalize: true,
      requiresArg: true,
      type: 'string',
    },
    'verbose': {
      alias: 'v',
      describe: 'Show verbose output',
      type: 'boolean',
    },
  });

  program
    .command(
      'build',
      'Create a web extension package from source',
      commands.build, {
        'as-needed': {
          describe: 'Watch for file changes and re-build as needed',
          type: 'boolean',
        },
      })
    .command(
      'sign',
      'Sign the web extension so it can be installed in Firefox',
      commands.sign, {
        'api-key': {
          describe: 'API key (JWT issuer) from addons.mozilla.org',
          demand: true,
          type: 'string',
        },
        'api-secret': {
          describe: 'API secret (JWT secret) from addons.mozilla.org',
          demand: true,
          type: 'string',
        },
        'api-url-prefix': {
          describe: 'Signing API URL prefix',
          default: 'https://addons.mozilla.org/api/v3',
          demand: true,
          type: 'string',
        },
        'id': {
          describe:
            'A custom ID for the extension. This has no effect if the ' +
            'extension already declares an explicit ID in its manifest.',
          demand: false,
          type: 'string',
        },
        'timeout' : {
          describe: 'Number of milliseconds to wait before giving up',
          type: 'number',
        },
      })
    .command('run', 'Run the web extension', commands.run, {
      'firefox': {
        alias: 'f',
        describe: 'Path to a Firefox executable such as firefox-bin. ' +
                  'If not specified, the default Firefox will be used.',
        demand: false,
        type: 'string',
      },
      'firefox-profile': {
        alias: 'p',
        describe: 'Run Firefox using a copy of this profile. The profile ' +
                  'can be specified as a directory or a name, such as one ' +
                  'you would see in the Profile Manager. If not specified, ' +
                  'a new temporary profile will be created.',
        demand: false,
        type: 'string',
      },
      'no-reload': {
        describe: 'Do not reload the extension when source files change',
        demand: false,
        type: 'boolean',
      },
      'pre-install': {
        describe: 'Pre-install the extension into the profile before ' +
                  'startup. This is only needed to support older versions ' +
                  'of Firefox.',
        demand: false,
        type: 'boolean',
      },
    })
    .command('lint', 'Validate the web extension source', commands.lint, {
      'output': {
        alias: 'o',
        describe: 'The type of output to generate',
        type: 'string',
        default: 'text',
        choices: ['json', 'text'],
      },
      'metadata': {
        describe: 'Output only metadata as JSON',
        type: 'boolean',
        default: false,
      },
      'pretty': {
        describe: 'Prettify JSON output',
        type: 'boolean',
        default: false,
      },
      'self-hosted': {
        describe:
          'Your extension will be self-hosted. This disables messages ' +
          'related to hosting on addons.mozilla.org.',
        type: 'boolean',
        default: false,
      },
      'boring': {
        describe: 'Disables colorful shell output',
        type: 'boolean',
        default: false,
      },
    });

  return program.run(absolutePackageDir, runOptions);
}
