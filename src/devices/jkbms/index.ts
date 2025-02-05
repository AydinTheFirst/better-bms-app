/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { DeepRequired } from 'ts-essentials';
import { ResponseDecoder } from 'decoders/responseDecoder';
import {
  InternalData,
  INTERNAL_KEYS,
  LiveData,
  ResponseDataTypeRecord,
  ResponseDataTypes,
} from 'interfaces/data';
import { DecodedResponseData } from 'interfaces/decoder';
import {
  ConnectOptions,
  Device,
  DeviceCallbacks,
  DeviceIdentificator,
  DeviceStatus,
  DisconnectReasons,
} from 'interfaces/device';
import { CommandDefinition, ProtocolSpecification, ResponseDefinition } from 'interfaces/protocol';
import { wait } from 'utils/index';
import { bufferToHexString, intToHexString } from 'utils/binary';
import { DeviceLog } from 'utils/logger';
import { JKBMS_COMMANDS, JKBMS_PROTOCOL } from './config';

export class JKBMS implements Device {
  protocol!: DeepRequired<ProtocolSpecification<JKBMS_COMMANDS>>;
  status!: DeviceStatus;
  deviceIdenticator!: DeviceIdentificator | null;
  callbacks: DeviceCallbacks;
  decoder!: ResponseDecoder<JKBMS_COMMANDS>;
  responseBuffer!: Uint8Array;
  characteristic!: BluetoothRemoteGATTCharacteristic | null;
  bluetoothDevice!: BluetoothDevice | null;
  inactivityTimeout: ReturnType<typeof setTimeout> | null | undefined;
  cache!: Partial<ResponseDataTypeRecord>;

  constructor(callbacks: DeviceCallbacks) {
    DeviceLog.info(`JK BMS başlatılıyor`, { callbacks });

    this.decoder = new ResponseDecoder<JKBMS_COMMANDS>(JKBMS_PROTOCOL);
    // @ts-ignore
    this.protocol = this.decoder.getUnpackedProtocol();

    DeviceLog.info(
      `Kullanılan protokol ${this.protocol.name}
    Komutlar: [
        ${Object.values(this.protocol.commands)
          .map(({ name }) => name)
          .join(', ')}
    ]
    Cevaplar: [
        ${Object.values(this.protocol.responses)
          .map(({ name }) => name)
          .join(', ')}
    ]
`,
      {
        protocol: this.protocol,
      }
    );

    this.callbacks = callbacks;

    this.reset();

    DeviceLog.log(`Cihaz başlatıldı`, this);
  }

  private reset(): void {
    DeviceLog.log(`Cihaz resetlendi`, this);
    this.setStatus('disconnected');
    this.deviceIdenticator = null;
    this.cache = {};

    this.characteristic = null;
    this.bluetoothDevice = null;

    clearTimeout(this.inactivityTimeout ?? undefined);
    this.inactivityTimeout = null;

    this.flushResponseBuffer();
  }

  private setStatus(newStatus: DeviceStatus): void {
    DeviceLog.log(`Durum güncellendi: ${this.status} -> ${newStatus}`, {
      newStatus,
      oldStatus: this.status,
    });
    this.status = newStatus;
    this.callbacks.onStatusChange?.(newStatus);
  }

  async connect(options: ConnectOptions = {}): Promise<DeviceIdentificator | null> {
    DeviceLog.log(`Bağlanma prosedürü başlatıldı`, { options });
    this.setStatus('scanning');

    let device: BluetoothDevice | null = null;

    try {
      if (options?.previous && navigator.platform !== 'Linux x86_64') {
        DeviceLog.debug(`Önceki cihaz ayarları ${options.previous.name}`, {
          previous: options.previous,
        });
        const previousDevice = await this.tryGetPreviousDevice(options.previous);

        if (previousDevice) {
          DeviceLog.info(`Önceki cihaz kullanılıyor ${previousDevice.name}`, {
            previousDevice,
            options,
          });
          device = previousDevice;
        } else {
          // We can't call requestBluetoothDevice without second user interaction.
          // https:/developer.chrome.com/blog/user-activation/
          DeviceLog.info(`Diğer cihazlara izin vermek için bağlantı kesiliyor`, {
            previousDevice,
          });
          this.setStatus('disconnected');
          return null;
        }
      } else {
        DeviceLog.info(`Yeni cihaz isteniyor`, { options });
        const userSelectedDevice = await this.requestBluetoothDevice();
        DeviceLog.info(
          `Kullanıcı tarafından seçilen cihaz kullanılıyor ${userSelectedDevice.name}`,
          {
            userSelectedDevice,
          }
        );
        device = userSelectedDevice;
      }
    } catch (error) {
      console.error(error);
      // @ts-ignore
      DeviceLog.error(`Cihaz isteği başarısız. ${error?.message}`, {
        options,
        device,
      });
      this.setStatus('disconnected');
      this.callbacks.onRequestDeviceError?.(error as Error);

      return null;
    }

    try {
      DeviceLog.info(`Cihaza bağlanılıyor ${device.name}`, { device });
      this.setStatus('connecting');
      const server = await device.gatt?.connect().catch((error) => {
        console.error(error);
        throw new Error(`Cihazın GAAT sunucusununa bağlanılamadı ${device?.name}`);
      });
      DeviceLog.log(`Connected to ${device.name}`, { device, server });

      device.addEventListener('gattserverdisconnected', () => this.disconnect('external'));
      this.registerActivity();

      if (!server) {
        throw new Error(`Cihazın GAAT sunucusuna bağlanılamadı ${device.name}`);
      }

      DeviceLog.info(`Servisler alınıyor ${intToHexString(this.protocol.serviceUuid, '0x')}`, {
        server,
      });
      const service = await server?.getPrimaryService(this.protocol.serviceUuid).catch((error) => {
        console.error(error);
        throw new Error(`İlk servis bulunamadı ${intToHexString(this.protocol.serviceUuid, '0x')}`);
      });

      if (!service) {
        throw new Error(`Servis ${intToHexString(this.protocol.serviceUuid, '0x')} bulunamadı`);
      }

      DeviceLog.info(
        `Tipik özellikler alınıyor ${intToHexString(this.protocol.characteristicUuid, '0x')}`,
        { service }
      );
      const charateristic = await service
        ?.getCharacteristic(this.protocol.characteristicUuid)
        .catch((error) => {
          console.error(error);
          throw new Error(`Tipik özellikler alınamadı ${this.protocol.characteristicUuid}`);
        });

      if (!charateristic) {
        throw new Error(`Servis ${this.protocol.characteristicUuid} bulunamadı`);
      }

      this.characteristic = charateristic;
      this.bluetoothDevice = device;
      this.setStatus('connected');

      DeviceLog.log(`Cihaz ${device.name} komutlar için hazır`, {
        device,
        charateristic,
      });

      this.subscribeToDataNotifications();

      this.deviceIdenticator = {
        id: device.id,
        name: device.name || device.id,
      };

      DeviceLog.debug(
        `Cihazın kimlik bilgileri getiriliyor ${device.name} ${this.deviceIdenticator.id}`,
        {
          deviceIdentificator: this.deviceIdenticator,
        }
      );

      this.callbacks.onConnected?.(this.deviceIdenticator);

      return this.deviceIdenticator;
    } catch (error) {
      DeviceLog.error(
        // @ts-ignore
        error?.message || `Cihazı bağlarken bir sorun oluştu ${device.name}`,
        { device, error }
      );
      this.disconnect('error');
      this.callbacks.onRequestDeviceError?.(error as Error);
      return null;
    }
  }

  async disconnect(reason: DisconnectReasons): Promise<void> {
    if (this.status === 'disconnected' || !this.bluetoothDevice) {
      DeviceLog.warn(`Cihaz zaten bağlı değil`, this);

      // return;
    }

    try {
      DeviceLog.log(
        `Cihaz bağlantısı koparılıyor ${this.bluetoothDevice?.name}. sebep: ${reason}`,
        this
      );

      if (reason !== 'external') {
        await this.characteristic?.stopNotifications().catch((error) => {
          console.warn(error);
        });
        await wait(100);
        this.bluetoothDevice?.gatt?.disconnect();
        await wait(100);
      }

      this.callbacks?.onDisconnected?.(reason);

      this.reset();
    } catch (error) {
      DeviceLog.warn(`Cihaz bağlantısı koparılırken bir sorun oluştu. Yeniden yükleniyor`, {
        error,
      });
      document.location.reload();
    }
  }

  async pause(): Promise<void> {
    DeviceLog.log(`Cihaz bildirimleri durduruldu ${this.characteristic?.service.device.name}`, {
      characteristic: this.characteristic,
    });
    //
  }

  private async tryGetPreviousDevice(
    deviceIdenticator: DeviceIdentificator
  ): Promise<BluetoothDevice | null> {
    DeviceLog.info(`Bağlanmış cihazlar isteniyor ${location.origin}`, {
      location,
    });
    const pairedDevicesForThisOrigin = await navigator.bluetooth.getDevices();
    DeviceLog.info(`${pairedDevicesForThisOrigin.length} bağlanmış cihaz bulundu`, {
      pairedDevicesForThisOrigin,
    });
    const matchedDevice = pairedDevicesForThisOrigin?.find(
      (device) => device.id === deviceIdenticator.id
    );

    if (matchedDevice) {
      DeviceLog.info(`Bir önceki cihaza bağlanılıyor ${matchedDevice.name}`, {
        matchedDevice,
      });
      const abortController = new AbortController();

      // Wait for connection.
      await matchedDevice.watchAdvertisements({
        signal: abortController.signal,
      });

      DeviceLog.info(`Reklamları izliyorum?`, {
        matchedDevice,
        abortController,
      });

      const isMatchedDeviceInRange = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          DeviceLog.warn(`Herhangi bir reklam alınmadı ${this.protocol.connectPreviousTimeout}ms`);
          resolve(false);
        }, this.protocol.connectPreviousTimeout);

        const advertisementReceivedCallback = (event: BluetoothAdvertisingEvent) => {
          DeviceLog.info(`Alandaki önceki cihazlar ${event.rssi}rssi`, {
            event,
          });
          clearTimeout(timeout);
          resolve(true);
        };

        // @FIXME: remove listener after first advertismenet
        matchedDevice.addEventListener('advertisementreceived', advertisementReceivedCallback);
      });

      // unwatchAdvertisements hangs, use abort instead
      // matchedDevice.unwatchAdvertisements();
      abortController.abort();
      DeviceLog.debug(`Reklam izleme durduruldu`, {
        abortController,
        matchedDevice,
        isMatchedDeviceInRange,
      });

      if (!isMatchedDeviceInRange) {
        DeviceLog.warn(`Önceki cihaz  ${matchedDevice.name} geçersiz`, {
          matchedDevice,
          isMatchedDeviceInRange,
        });
        this.callbacks.onPreviousUnavailable?.(matchedDevice);

        return null;
      }

      DeviceLog.log(`Önceki cihaz ${matchedDevice.name} bağlantıya hazır`, {
        matchedDevice,
        isMatchedDeviceInRange,
      });

      return matchedDevice;
    }

    DeviceLog.warn(`Önceki cihaz ${deviceIdenticator.name} bu cihazla eşleştirilmemiş`, {
      deviceIdenticator,
      matchedDevice,
    });

    this.callbacks.onPreviousUnavailable?.(null);

    return null;
  }

  private async requestBluetoothDevice(): Promise<BluetoothDevice> {
    DeviceLog.info(
      `Cihazlar şu ${intToHexString(this.protocol.serviceUuid, '0x')} uuid ile taranıyor`,
      {
        serviceUuid: this.protocol.serviceUuid,
      }
    );
    const device = await navigator.bluetooth.requestDevice({
      filters: [
        {
          services: [this.protocol.serviceUuid],
        },
      ],
    });

    DeviceLog.debug(`Cihazı kullanmak için izin alındı ${device.name}`, { device });

    return device;
  }

  private registerActivity(): ReturnType<typeof setTimeout> {
    if (this.inactivityTimeout !== null) {
      clearTimeout(this.inactivityTimeout);
    }
    this.inactivityTimeout = setTimeout(() => {
      DeviceLog.warn(`Bağlantı ${this.deviceIdenticator?.name} hareketsizlik sebebiyle kesildi`);
      this.disconnect('inactivity');
    }, this.protocol.inactivityTimeout);

    return this.inactivityTimeout;
  }

  private async subscribeToDataNotifications(): Promise<void> {
    if (!this.characteristic) {
      DeviceLog.error(`Abone olunamıyor önce bağlantı sağlanmalı.`);
      return;
    }

    try {
      DeviceLog.log(`Bildirimler dinleniyor`, {
        characteristic: this.characteristic,
      });
      this.characteristic.addEventListener(
        'characteristicvaluechanged',
        this.handleNotification.bind(this)
      );

      await this.characteristic.startNotifications();
      await wait(200);
      // Sending these two commands start live data notifications
      await this.sendCommand(JKBMS_COMMANDS.GET_SETTINGS);
      await this.sendCommand(JKBMS_COMMANDS.GET_DEVICE_INFO);
      DeviceLog.info(`Hücre verisi verileri dinleniyor`);
    } catch (error) {
      // @ts-ignore
      DeviceLog.error(error.message);
      DeviceLog.error(`Bir hata oluştu`, {
        error,
      });
      this.disconnect('error');
      this.callbacks.onError?.(error as Error);
    }
  }

  private async sendCommand(commandName: JKBMS_COMMANDS, payload?: Uint8Array): Promise<void> {
    DeviceLog.info(`Komut göndermeye hazırlanıyor ${commandName}`, this);
    if (!this.characteristic) {
      throw new Error(`Bağlanmadan komut gönderilemez`);
    }

    const command = this.protocol.getCommandByName(commandName) as DeepRequired<
      CommandDefinition<JKBMS_COMMANDS>
    >;

    if (!command) {
      const msg = `Komut ${commandName} bu protokol ${this.protocol.name} için geçerli değil`;
      DeviceLog.error(msg, { commandName, command, protocol: this.protocol });

      throw new Error(msg);
    }

    const timeout = setTimeout(() => {
      throw new Error(`Komut ${commandName} ${command.timeout}ms süresinde tamamlanamadı`);
    }, command.timeout);

    const preparedCommand = this.constructCommandPayload(command, payload);

    try {
      DeviceLog.log(
        `===== Komut gönderiliyor ${commandName} ${
          payload ? `yük ${bufferToHexString(payload, '', '', '0x')}` : ''
        } to ${this.characteristic.service.device.name} =====`,
        { command, preparedCommand }
      );
      if (payload) {
        await this.characteristic.writeValueWithResponse(preparedCommand.buffer as ArrayBuffer);
      } else {
        await this.characteristic.writeValueWithoutResponse(preparedCommand.buffer as ArrayBuffer);
      }
    } catch (error) {
      console.error(error);
      const msg = `Komut ${commandName} başarısız oldu`;
      DeviceLog.error(msg, { error, command });
      throw new Error(msg);
    }

    clearTimeout(timeout);

    if (command.wait) {
      DeviceLog.debug(`Yeni bir komut göndermeden önce ${command.wait}ms bekle`, {
        command,
      });
      await wait(command.wait);
    }
  }

  private constructCommandPayload(
    command: Required<CommandDefinition>,
    payload: Uint8Array = new Uint8Array([])
  ): Uint8Array {
    DeviceLog.debug(`Yük yapılandırılıyor ${command.name}`, { command });
    const template = new Uint8Array(this.protocol.commandLength);
    const tempBuffer = new Uint8Array([
      ...this.protocol.commandHeader,
      ...command.code,
      ...payload,
    ]);

    if (this.protocol.commandLength && tempBuffer.byteLength > this.protocol.commandLength) {
      const msg = `Komut ${command.name} yük ${tempBuffer.byteLength} B protokol limitlerini aştı ${this.protocol.commandLength} B`;
      DeviceLog.error(msg, { command, tempBuffer, payload });

      throw new Error(msg);
    }

    const commandBuffer = new Uint8Array([...tempBuffer, ...template]).slice(
      0,
      this.protocol.commandLength
    );
    DeviceLog.debug(`Komut pre checksum: ${bufferToHexString(commandBuffer)}`, { commandBuffer });
    const checksum = this.calculateChecksum(commandBuffer.slice(0, -1));

    commandBuffer[commandBuffer.length - 1] = checksum;
    DeviceLog.debug(`Komut with checksum: ${bufferToHexString(commandBuffer)}`, {
      commandBuffer,
      checksum,
    });

    return commandBuffer;
  }

  async toggleCharging(value: boolean): Promise<void> {
    try {
      await this.sendCommand(JKBMS_COMMANDS.TOGGLE_CHARGING, new Uint8Array([value ? 0x01 : 0x00]));
      DeviceLog.info(`Şarj aç/kapa ${value} başarılı. Ayarlar yeniden getiriliyor`);
    } finally {
      await this.sendCommand(JKBMS_COMMANDS.GET_SETTINGS);
    }
  }

  async toggleDischarging(value: boolean): Promise<void> {
    try {
      await this.sendCommand(
        JKBMS_COMMANDS.TOGGLE_DISCHARGING,
        new Uint8Array([value ? 0x01 : 0x00])
      );
      DeviceLog.info(`Deşarj aç/kapa ${value} başarılı. Ayarlar yeniden getiriliyor`);
    } finally {
      await this.sendCommand(JKBMS_COMMANDS.GET_SETTINGS);
    }
  }

  private handleNotification(event: Event): void {
    this.registerActivity();
    const value = (event.target as BluetoothRemoteGATTCharacteristic).value;

    if (!value?.byteLength) {
      DeviceLog.warn(`Boş bildirim alındı`, { value, event });
      return;
    }

    const valueArray = new Uint8Array(value.buffer);

    DeviceLog.debug(
      // @ts-ignore
      `===== ${event.target?.service?.device?.name} cihazından bildirim alındı (${value.byteLength} bytes) =====`,
      { event, value, responseBuffer: this.responseBuffer, it: this }
    );

    try {
      if (this.doesStartWithSegmentHeader(valueArray)) {
        DeviceLog.debug(`Segment başlıkları bulundu`);
        this.flushResponseBuffer();
        this.responseBuffer = valueArray;
      } else {
        // responseBuffer should always start with segment header or have 0 length
        if (this.doesStartWithSegmentHeader(this.responseBuffer)) {
          DeviceLog.debug(
            `Önceki segmente atandı. Toplam uzunluk ${
              this.responseBuffer.byteLength + valueArray.byteLength
            }`,
            { responseBuffer: this.responseBuffer, valueArray }
          );

          this.responseBuffer = new Uint8Array([...this.responseBuffer, ...valueArray]);
        } else {
          DeviceLog.warn(`Segment başlığı önce gelmeli`, {
            responseBuffer: this.responseBuffer,
            valueArray,
          });
          return;
        }
      }

      const segmentType = this.getSegmentType(this.responseBuffer);

      const expectedSegments = this.protocol.responses.map(
        (responseDefinition) => responseDefinition.signature[0]
      );

      if (!expectedSegments.includes(segmentType)) {
        DeviceLog.warn(`beklenmeyen segment tipi ${intToHexString(segmentType, '0x')}`);

        return;
      }

      const responseDefinition = this.protocol.getResponseBySignature(
        new Uint8Array([segmentType])
      )!;

      if (this.isSegmentComplete(this.responseBuffer, responseDefinition)) {
        if (!this.isChecksumCorrect(this.responseBuffer)) {
          DeviceLog.warn(`Segment bozuldu ${responseDefinition.name}`, {
            responseBuffer: this.responseBuffer,
          });
          this.flushResponseBuffer();
          return;
        }

        try {
          DeviceLog.debug(`Segment tamamlandı. Çözümleniyor ${responseDefinition.name}`, {
            responseBuffer: this.responseBuffer,
          });

          const decodedData = this.decoder!.decode(
            responseDefinition.dataType,
            new Uint8Array([segmentType]),
            this.responseBuffer
          );

          this.handleDecodedData(responseDefinition.dataType, decodedData);

          this.flushResponseBuffer();
        } catch (error) {
          console.error(error);
          DeviceLog.error(`${responseDefinition.name} veri çözümleme başarısız`, {
            error,
          });
          return;
        }
      } else {
        DeviceLog.debug(`Segment tamamlanmadı. Bekleniyor`);
      }
    } catch (error) {
      console.error(error);
      DeviceLog.error('Bildirim, Bilinmeyen hata', { error });
      this.flushResponseBuffer();
    }

    DeviceLog.debug(`Bildirim işlendi`);
  }
  private doesStartWithSegmentHeader(buffer: Uint8Array): boolean {
    DeviceLog.debug(
      `Segment başlığı kontrol ediliyor ${bufferToHexString(this.protocol.segmentHeader)}`,
      { buffer, header: this.protocol.segmentHeader }
    );
    return (
      buffer.byteLength > this.protocol.segmentHeader.byteLength &&
      this.protocol.segmentHeader.every((value, i) => value === buffer[i])
    );
  }

  private isSegmentComplete(segment: Uint8Array, responseDefinition: ResponseDefinition): boolean {
    DeviceLog.debug(`Segmentin tamamlanıp tamamlanmadığı kontrol ediliyor`, {
      segment,
      responseDefinition,
    });

    if (!this.doesStartWithSegmentHeader(segment)) {
      // Bu olmamalı
      DeviceLog.warn(`Segment başlığı olmadan tamamlanamaz`, {
        segment,
      });
      return false;
    }

    if (segment.length === responseDefinition.length) {
      DeviceLog.debug(`Segment beklenen uzunlukta ${responseDefinition.length} bayt`, {
        segment,
        responseDefinition,
      });
      return true;
    } else if (segment.length > responseDefinition.length) {
      DeviceLog.warn(
        `Segment beklenen uzunluktan ${
          segment.length - responseDefinition.length
        } bayt daha uzun. Dikkatli devam edin`,
        { segment, responseDefinition }
      );

      return true;
    }

    DeviceLog.debug(
      `Segmentin tamamlanması için ${
        responseDefinition.length - segment.length
      } bayta daha ihtiyacı var`,
      { segment, responseDefinition }
    );
    return false;
  }

  private isChecksumCorrect(segment: Uint8Array): boolean {
    const checksum = segment.at(-1);

    const calculatedChecksum = this.calculateChecksum(segment.slice(0, -1));

    if (checksum === calculatedChecksum) {
      DeviceLog.debug(`Checksum doğru ${intToHexString(checksum, '0x')}`);
      return true;
    }

    DeviceLog.warn(
      `Checksum ${intToHexString(calculatedChecksum, '0x')} geçersiz, beklenen ${intToHexString(
        checksum!,
        '0x'
      )}`
    );

    return false;
  }

  private getSegmentType(segment: Uint8Array): number {
    const segmentType = segment[this.protocol.segmentHeader.length];

    DeviceLog.debug(`Segment tipi tespit edildi ${intToHexString(segmentType, '0x')}`);

    return segmentType;
  }

  private calculateChecksum(byteArray: Uint8Array): number {
    DeviceLog.debug(`Checksum hesaplanıyor ${byteArray.byteLength} bayt için`, {
      byteArray,
    });
    const sum = byteArray.reduce((acc, byte) => (acc += byte), 0);

    const checksum = sum & 0xff;

    console.assert(checksum <= 255);
    DeviceLog.debug(`Hesaplanan checksum: ${intToHexString(checksum, '0x')}`, {
      byteArray,
      checksum,
    });

    return checksum;
  }

  private flushResponseBuffer(): void {
    DeviceLog.debug(`Yanıt tamponu boşaltılıyor ${this.responseBuffer?.byteLength ?? 0} bayt`, {
      responseBuffer: this.responseBuffer,
    });
    this.responseBuffer = new Uint8Array([]);
  }

  private handleDecodedData<T extends ResponseDataTypes>(
    dataType: T,
    decodedData: DecodedResponseData<T>
  ): void {
    const timestamp = new Date().valueOf();
    const lastData = this.cache[dataType];
    const timeSinceLastOne = lastData?.timestamp ? timestamp - lastData.timestamp : null;

    DeviceLog.debug(`Genel veri hazırlanıyor`, {
      decodedData,
      timeSinceLastOne,
      timestamp: new Date(timestamp),
    });

    const internalData: Partial<InternalData> = {};

    const publicData = {
      timestamp,
      timeSinceLastOne,
      ...decodedData,
    } as ResponseDataTypeRecord[T];

    Object.keys(publicData).forEach((key) => {
      // @ts-ignore
      if (INTERNAL_KEYS.includes(key)) {
        // @ts-ignore
        internalData[key] = publicData[key];
        // @ts-ignore
        delete publicData[key];
      }
    });

    if (dataType === 'LIVE_DATA') {
      DeviceLog.debug(
        `${dataType} geldi ${(publicData as LiveData)?.voltage}V Ping: ${
          publicData.timeSinceLastOne
        }ms`,
        { publicData, decodedData, internalData }
      );
    } else {
      DeviceLog.info(`===== ${dataType} verisi hazır. ${Object.keys(publicData).length} öğe =====`);
    }

    this.cache[dataType] = publicData;

    this.callbacks.onDataReceived(dataType, publicData);
  }
}
