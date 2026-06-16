/**
 * Central logger (electron-log). File + console transports; logs land in userData/logs.
 * MAIN-process only.
 */
import log from 'electron-log/main';

log.initialize();
log.transports.file.level = 'info';
log.transports.console.level = 'debug';

export { log };
