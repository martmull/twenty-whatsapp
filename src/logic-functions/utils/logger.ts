type LogData = Record<string, unknown>;

const write = (level: 'info' | 'warn' | 'error', name: string, message: string, data?: LogData) => {
  console[level](JSON.stringify({ level, function: name, message, ...data }));
};

export const createLogger = (name: string) => ({
  info: (message: string, data?: LogData) => write('info', name, message, data),
  warn: (message: string, data?: LogData) => write('warn', name, message, data),
  error: (message: string, data?: LogData) => write('error', name, message, data),
});

export type Logger = ReturnType<typeof createLogger>;
