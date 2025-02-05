import { ResponseDataTypes } from 'interfaces/data';
import { DecodedResponseData, Decoder } from 'interfaces/decoder';
import {
  ItemDescription,
  PackedProtocolSpecification,
  ProtocolSpecification,
} from 'interfaces/protocol';
import { bufferToHexString, intToHexString } from 'utils/binary';
import { DecodeLog, DeviceLog } from 'utils/logger';
import { unpackProtocol } from 'utils/unpackProtocol';

export class ResponseDecoder<T extends string> implements Decoder<T> {
  protocol: ProtocolSpecification<T>;
  utf8Decoder: TextDecoder;

  constructor(packedProtocol: PackedProtocolSpecification<T>) {
    DecodeLog.log(`Cevap çözümleyici başlatılıyor: Protokol: ${packedProtocol.name}`, {
      packedProtocol,
    });
    const protocol = unpackProtocol(packedProtocol);

    const isValid = this.validateProtocol(protocol);

    if (!isValid) {
      const msg = `Protokol ${protocol.name} geçersşz!`;
      DecodeLog.error(msg, { protocol });
      throw new Error(msg);
    }

    this.utf8Decoder = new TextDecoder('utf-8');
    this.protocol = protocol;

    DecodeLog.log(`${protocol.name} çözümleyici başlatıldı`, this);
  }

  getUnpackedProtocol(): ProtocolSpecification<T> {
    return this.protocol;
  }

  validateProtocol(protocol: ProtocolSpecification<T>): boolean {
    DecodeLog.info(`Protokol doğrulanıyor ${protocol.name}`, { protocol });

    let isValid = false;
    try {
      isValid = true;

      const areResponsesLengthsCorrect = protocol.responses.every((response) => {
        const calculatedLength = (response.items as ItemDescription<ResponseDataTypes>[]).reduce(
          (byteSum, itemDescription) => (byteSum += itemDescription.byteLength),
          0
        );

        if (calculatedLength === response.length) {
          return true;
        } else {
          DecodeLog.warn(
            `Cevap ${response.name} hesaplanan uzunluk ${calculatedLength} Cevap bitleri ile ${response.length} eşleşmiyor`,
            { response }
          );
          return false;
        }
      });

      if (!areResponsesLengthsCorrect) {
        DeviceLog.error(`Protokolun ${protocol.name} cevap uzunluğu eşleşmiyor`, { protocol });
        isValid = false;
      }
    } catch (error) {
      isValid = false;
      // @ts-ignore
      errors.push(error?.message || 'unkown error');
      console.error(error);
      DecodeLog.error(`Protokolde bilinmeyen bir hata oluştu!`, {
        protocol,
        error,
      });
    }

    return isValid;
  }

  decode<T extends ResponseDataTypes = ResponseDataTypes>(
    responseType: T,
    responseSignature: Uint8Array,
    responseBuffer: Uint8Array
  ): DecodedResponseData<T> {
    const responseDefinition = this.protocol.getResponseBySignature<T>(responseSignature);

    if (!responseDefinition) {
      const msg = `İmzayla eşleşen yanıt tanımı ${bufferToHexString(
        responseSignature,
        '',
        '',
        '0x'
      )} not found`;
      DecodeLog.error(msg, { responseSignature });

      throw new Error(msg);
    }

    let currentDataItem = null;

    try {
      DecodeLog.log(
        `ÇÖzümleniyor ${responseType} ${bufferToHexString(responseSignature, '', '', '0x')} (${
          responseBuffer.byteLength
        } bytes)`,
        {
          responseType,
          responseBuffer,
        }
      );

      DecodeLog.debug(bufferToHexString(responseBuffer));
      const decodedDataAcc: DecodedResponseData<T> = {};

      for (const dataItem of responseDefinition.items) {
        currentDataItem = dataItem;
        const buffer = responseBuffer.slice(dataItem.offset, dataItem.offset + dataItem.byteLength);

        DecodeLog.debug(
          `Çözümleniyor ${dataItem.type} öğe ${String(dataItem.key)} offset ${dataItem.offset}`,
          { dataItem, accumulator: decodedDataAcc, responseBuffer, buffer }
        );

        let value;

        switch (dataItem.type) {
          case 'raw': {
            if (dataItem.getterFunction) {
              const processedValue = dataItem.getterFunction({
                itemBuffer: buffer.buffer,
                byteLength: dataItem.byteLength,
                offset: dataItem.offset,
                responseBuffer: responseBuffer.buffer as ArrayBuffer,
              });

              DecodeLog.debug(`Çözümlendi işlenen saf değer ${processedValue.toString}`, {
                processedValue,
                dataItem,
                buffer,
              });

              value = processedValue;
            } else {
              DecodeLog.debug(`Çözümlendi saf değer ${buffer.byteLength} bytes`, {
                dataItem,
                buffer,
              });

              value = buffer;
            }

            break;
          }
          case 'text': {
            switch (dataItem.textEncoding) {
              case 'hex': {
                const hexString = bufferToHexString(buffer, ' ', '');

                DecodeLog.debug(`Çözümlendi HexString ${buffer.byteLength} bytes \n${hexString}`, {
                  hexString,
                  buffer,
                  dataItem,
                });

                value = hexString;

                break;
              }
              case 'UTF-8':
              case 'ASCII': {
                const encodedString = this.utf8Decoder.decode(buffer).replaceAll('\u0000', '');

                DecodeLog.debug(
                  `Çözümlendi utf-8 or ascii metin ${encodedString.length} ch \n${encodedString}`,
                  { encodedString, buffer, dataItem }
                );

                value = encodedString;

                break;
              }
            }

            break;
          }
          case 'numeric': {
            const view = new DataView(buffer.buffer);
            const isLittleEndian: boolean | undefined =
              dataItem.numberType === 'Int8' || dataItem.numberType === 'Uint8'
                ? undefined
                : dataItem.endiannes === 'littleEndian'
                ? true
                : false;

            const getter = `get${dataItem.numberType}`;

            DecodeLog.debug(
              `Çözümleniyor ${dataItem.endiannes ?? ''} ${dataItem.numberType} (${
                buffer.byteLength * 8
              } bits)`,
              { view, isLittleEndian, dataItem, buffer }
            );

            // @ts-ignore
            const decodedValue = view[getter](0, isLittleEndian) as number;

            let processedValue = decodedValue;
            if (dataItem.options.multiplayer !== undefined) {
              processedValue = processedValue * dataItem.options.multiplayer;
            }
            if (dataItem.options.precision !== undefined) {
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              processedValue = Number(processedValue.toFixed(dataItem.options.precision ?? 5))!;
            }

            DecodeLog.debug(
              `Çözümlendi ${dataItem.endiannes ?? ''} ${
                dataItem.numberType
              } = ${processedValue} ${intToHexString(decodedValue, '0x')}`,
              {
                view,
                isLittleEndian,
                dataItem,
                buffer,
                decodedValue,
              }
            );
            value = processedValue;

            break;
          }
          case 'boolean': {
            const isSomeByteNotZero = buffer.some((byte) => byte > 0);

            DecodeLog.debug(
              `Çözümlendi boolean ${String(isSomeByteNotZero)} ${bufferToHexString(
                buffer,
                '',
                '',
                '0x'
              )}`,
              {
                isSomeByteNotZero,
                buffer,
                dataItem,
              }
            );

            value = isSomeByteNotZero;
            break;
          }
          default: {
            //  @ts-expect-error
            DecodeLog.warn(`Beklenmeyen veri tipi ${dataItem.type}`, {
              dataItem,
              buffer,
              responseDefinition,
            });
          }
        }

        currentDataItem = null;

        const doesValueAlreadyExist = Object.hasOwn(decodedDataAcc, dataItem.key);

        if (doesValueAlreadyExist) {
          // @ts-ignore
          const existingValue = decodedDataAcc[dataItem.key];

          if (
            (typeof existingValue === 'object' && typeof existingValue.length === 'undefined') ||
            typeof existingValue !== 'object'
          ) {
            DecodeLog.info(`$${String(dataItem.key)} zaten var. Dizi oluşturuluyor`, {
              existingValue,
              dataItem,
              accumulator: decodedDataAcc,
            });

            value = [existingValue, value];
          } else {
            value = [...existingValue, value];
            DecodeLog.debug(
              `Başka bir değere bağlanıyor ${String(dataItem.key)}. Toplam uzunluk ${value.length}`,
              { existingValue, dataItem, accumulator: decodedDataAcc }
            );
          }
        }

        // @ts-ignore
        decodedDataAcc[dataItem.key] = value;
      }

      DecodeLog.log(
        `Başarıyla çözümlendi ${responseDefinition.name} (${
          Object.entries(decodedDataAcc).length
        } öğeler)`,
        { decodedDataAcc, responseDefinition, responseBuffer },
        decodedDataAcc
      );

      return decodedDataAcc;
    } catch (error) {
      console.log(error);
      DecodeLog.error(
        `Çözümleniyor ${responseDefinition.name} başarısız oldu ${
          currentDataItem ? `${String(currentDataItem.key)}` : 'null'
        } at ${currentDataItem?.offset}`,
        { error, responseDefinition, responseBuffer }
      );
      throw error;
    }
  }
}
