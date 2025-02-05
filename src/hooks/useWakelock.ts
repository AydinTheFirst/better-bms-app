import { useCallback, useMemo, useRef } from 'react';
import { GlobalLog } from 'utils/logger';

export function useWakelock() {
  const wakelokRef = useRef<WakeLockSentinel>();

  const acquireWakelock = useCallback(async () => {
    try {
      if ('wakeLock' in navigator) {
        wakelokRef.current = await navigator.wakeLock.request('screen');
      } else {
        throw new Error('WakeLock desteklenmiyor');
      }
    } catch (error) {
      GlobalLog.warn(`WakeLock edinilemedi`, { error });
    }
  }, []);

  const releaseWakelock = useCallback(async () => {
    if (wakelokRef.current) {
      GlobalLog.info(`WakeLock bırakılıyor`, { wakelokRef });
      await wakelokRef.current.release();
    }
  }, []);

  return useMemo(
    () => ({ wakelokRef, acquireWakelock, releaseWakelock }),
    [wakelokRef, acquireWakelock, releaseWakelock]
  );
}
