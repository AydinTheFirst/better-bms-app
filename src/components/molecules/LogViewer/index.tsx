import Logger, { ILogLevel } from 'js-logger';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { consoleHandler, GlobalLog, LOG_SCOPES, UILog } from 'utils/logger';
import LogItem from './LogItem';
import { LogCount, LogViewerContainer, ScrollContainer } from './styles';

export type LogType = [number, string, ILogLevel['name'], LOG_SCOPES, string];

const LogViewer = () => {
  const isHandlerSet = useRef(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrollLockTimeout = useRef<ReturnType<typeof setTimeout> | null | undefined>(undefined);
  const ignoreScrolls = useRef<number>(0);
  const [logs, setLogs] = useState<LogType[]>(() => []);

  const addLog = useCallback(
    (date: string, level: ILogLevel['name'], scope: LOG_SCOPES, message: string) => {
      setLogs((current) => {
        const key = (current[current.length - 1]?.[0] || 0) + 1;
        const log = [key, date, level, scope, message] as LogType;

        if (current.length > 10000) {
          try {
            GlobalLog.info(`Konsol temizleniyor...`, { current });

            console.clear();
          } catch (e) {
            //
          }
        }

        if (current.length > 500) {
          UILog.info(`Performans iyileştirmek için eski loglar siliniyor ${500 - 100}`, {
            current,
          });
          return [...current, log].slice(-400);
        }

        return [...current, log];
      });
    },
    [setLogs, scrollContainerRef]
  );

  useLayoutEffect(() => {
    if (typeof scrollLockTimeout.current !== 'number' && scrollContainerRef.current) {
      ignoreScrolls.current += 1;
      scrollContainerRef.current.scrollTo(0, scrollContainerRef.current.scrollHeight);
    }
  }, [logs]);

  const handleScroll = useCallback<React.UIEventHandler<HTMLDivElement>>(() => {
    if (ignoreScrolls.current === 0) {
      if (scrollLockTimeout.current) {
        clearTimeout(scrollLockTimeout.current);
      }

      scrollLockTimeout.current = setTimeout(() => (scrollLockTimeout.current = null), 10000);
    } else if (ignoreScrolls.current > 0) {
      ignoreScrolls.current -= 1;
    }
  }, []);

  useLayoutEffect(() => {
    if (!isHandlerSet.current) {
      GlobalLog.log('Günlük görüntüleyici için loglama ayarlandı');

      Logger.setHandler((originalMessages, context) => {
        const { date, scope } = consoleHandler(originalMessages, context);

        addLog(date, context.level.name.toLowerCase(), scope, originalMessages[0].toString());
      });

      isHandlerSet.current = true;
    }
  }, []);

  useEffect(() => {
    GlobalLog.log('Günlük görüntüleyici için loglama ayarlandı');
  }, []);

  return (
    <LogViewerContainer>
      <LogCount>{`Günlük Sayısı: ${logs.length}`}</LogCount>
      <ScrollContainer ref={scrollContainerRef} onScroll={handleScroll}>
        {logs.map((log) => (
          <LogItem log={log} key={log[0]} />
        ))}
      </ScrollContainer>
    </LogViewerContainer>
  );
};

export default memo(LogViewer);
