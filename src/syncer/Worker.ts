import EventEmitter from "events";
import { v4 } from "uuid";
import { LoggerService as Logger } from "../services";
import { Block, DataTypes, Schemas, WorkerEvent } from "../types";
import {
  delay,
  getMiddleDate,
  isHighDensityBlock,
  isSuccessResponse,
  parseTimestamp,
  RecordRoots,
} from "../utils";
import { Controller } from "./Controller";

interface WorkerData {
  block: Block | null;
  continuation: string | null;
}

type ControllerInstance = InstanceType<typeof Controller>;

export class Worker extends EventEmitter {
  public busy: boolean = false;

  public data: WorkerData = {
    block: null,
    continuation: null,
  };

  /**
   * Continuation cursor to paginate through results
   * @access public
   */
  public continuation: string = "";

  /**
   * Datatype of the worker
   * @private
   */
  private readonly _datatype: DataTypes;

  /**
   * Request method inherited from the controller
   * @private
   */
  private readonly _request: ControllerInstance["request"];

  /**
   * Normalize parameters method inherited from the controller
   * @private
   */
  private readonly _normalize: ControllerInstance["normalize"];

  /**
   * Get config property method inhertied from the controller
   * @private
   */
  private readonly _config: ControllerInstance["getConfigProperty"];

  /**
   * Insert method inherited from the controller
   * @private
   */
  private readonly _insert: ControllerInstance["insert"];

  constructor(controller: Controller) {
    super();

    this._insert = controller.insert.bind(controller);
    this._request = controller.request.bind(controller);
    this._normalize = controller.normalize.bind(controller);
    this._config = controller.getConfigProperty.bind(controller);

    this._datatype = this._config("dataset");
  }

  public async process(
    { startDate, id, endDate, contract, priority }: Block,
    grain: boolean = true
  ): Promise<void> {
    this.busy = true;
    this.data.block = { startDate, endDate, id, priority, contract };

    if (grain) {
      const ascRes = await this._request(
        this._normalize({
          ...(contract && { contract: contract }),
          startTimestamp: parseTimestamp(startDate),
          endTimestamp: parseTimestamp(endDate),
          sortDirection: "asc",
        })
      );

      if (!isSuccessResponse(ascRes)) {
        await delay(5000);
        return await this.process({
          startDate,
          endDate,
          id,
          contract,
          priority,
        });
      }

      if (![...ascRes.data[RecordRoots[this._config("dataset")]]].length) {
        return this._release({ startDate, id, endDate, contract, priority });
      }

      Logger.warn(`Graining Block\nid:${id}`);

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const descRes = await this._request(
          this._normalize({
            ...(contract && { contract: contract }),
            startTimestamp: parseTimestamp(startDate),
            endTimestamp: parseTimestamp(endDate),
            sortDirection: "desc",
          })
        );

        if (!isSuccessResponse(descRes)) {
          await delay(5000);
          continue;
        }

        const records = [
          ...ascRes.data[RecordRoots[this._datatype]],
          ...descRes.data[RecordRoots[this._datatype]],
        ] as Schemas;

        await this._insert(records);

        const isHighDensity = isHighDensityBlock(records, 600000);

        if (isHighDensity) {
          const middleDate = getMiddleDate(startDate, endDate);

          /**
           * The graining got to fine. Meaning it's been processing
           * and it trying to become an upkeeper. We don't want that, so
           * we release and return it ourselves.
           *
           */
          if (middleDate === startDate || middleDate === endDate) {
            return this._release({
              startDate,
              endDate,
              id,
              contract,
              priority,
            });
          }

          this._split({
            startDate: middleDate,
            endDate,
            id,
            contract,
            priority: 2,
          });
          endDate = middleDate;
          continue;
        }

        break;
      }
      Logger.info(`Grained Block\nid:${id}`);
    }

    Logger.warn(`Processing Block \nid: ${id}`);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await this._request(
        this._normalize({
          ...(this.continuation && { continuation: this.continuation }),
          sortDirection: "asc",
          startTimestamp: parseTimestamp(startDate),
          endTimestamp: parseTimestamp(endDate),
        })
      );

      if (!isSuccessResponse(res)) {
        await delay(5000);
        continue;
      }

      const records = res.data[RecordRoots[this._datatype]];

      if (!records.length) {
        break;
      }

      await this._insert(records);

      if (!res.data.continuation) {
        break;
      } else this.continuation = res.data.continuation;
    }
    Logger.info(
      `Processed Block ${id}\nstartDate: ${startDate} endDate: ${endDate}`
    );
    this._release({ startDate, endDate, id, contract, priority });
  }

  public async upkeep(): Promise<void> {
    let startDate = new Date(
      (+new Date().getTime() - +new Date().getTimezoneOffset() * 60 * 1000) /
        1000
    ).toISOString();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      await delay(60000);

      const ascRes = await this._request(
        this._normalize(
          {
            ...(this.continuation && { continuation: this.continuation }),
            sortDirection: "asc",
            startTimestamp: parseTimestamp(startDate),
            endTimestamp: 253402300799,
          },
          false
        )
      );

      if (!isSuccessResponse(ascRes)) continue;

      const records = ascRes.data[RecordRoots[this._datatype]];

      if (!records.length) continue;

      await this._insert(records);

      if (!ascRes.data.continuation) continue;

      const descRes = await this._request(
        this._normalize(
          {
            ...(this.continuation && { continuation: this.continuation }),
            sortDirection: "desc",
            startTimestamp: parseTimestamp(startDate),
            endTimestamp: 253402300799,
          },
          false
        )
      );

      if (!isSuccessResponse(descRes)) continue;

      const isHighDensity = isHighDensityBlock(
        [
          ...ascRes.data[RecordRoots[this._datatype]],
          ...descRes.data[RecordRoots[this._datatype]],
        ] as Schemas,
        300000
      );

      if (isHighDensity) {
        const endDate = records[records.length - 1].updatedAt;

        /**
         * The graining got to fine. Meaning it's been processing
         * and it trying to become an upkeeper. We don't want that, so
         * we release and return it ourselves.
         *
         */
        if (
          records[0].updatedAt === startDate ||
          records[0].updatedAt === endDate
        )
          return;

        this._split({
          priority: 1,
          startDate: records[0].updatedAt,
          endDate,
          id: v4(),
          contract: "",
        });
        startDate = records[records.length - 1].updatedAt;
      }
    }
  }
  /**
   * Emit a split event for a block.
   * @param {Block} block - The block to emit a split event for.
   */
  private _split(block: Block) {
    this.emit("worker.event", {
      type: "worker.split",
      block,
    } as WorkerEvent);
  }
  /**
   * Emit a release event for a block.
   * @param {Block} block - The block to emit a release event for.
   */
  private _release(block: Block): void {
    Logger.info(`Released block: ${block.id}`);
    this.busy = false;
    this.continuation = "";
    this.emit("worker.event", {
      type: "worker.release",
      block: block,
    } as WorkerEvent);
  }
}
