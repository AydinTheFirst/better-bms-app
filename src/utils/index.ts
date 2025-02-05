import { GlobalLog } from './logger';

export async function wait(duration: number): Promise<void> {
  GlobalLog.info(`Bekleniyor ${duration} ms`);
  return new Promise((resolve) =>
    setTimeout(() => {
      GlobalLog.info(`Bekleme süresi ${duration} ms doldu`);
      resolve();
    }, duration)
  );
}
