import * as core from "@actions/core";

const PREFIX = "[cloudnua]";

export const logger = {
  debug(message: string): void {
    core.debug(`${PREFIX} ${message}`);
  },

  info(message: string): void {
    core.info(`${PREFIX} ${message}`);
  },

  warning(message: string): void {
    core.warning(`${PREFIX} ${message}`);
  },

  error(message: string | Error): void {
    core.error(message instanceof Error ? `${PREFIX} ${message.message}` : `${PREFIX} ${message}`);
  },

  group<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return core.group(`${PREFIX} ${name}`, fn);
  },
};
