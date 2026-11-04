/** 单次端口调用的瞬时观察者，不写入任务、缓存或provider配置。 */
export interface TranslationObserver {
  /** 视口更新可在逻辑任务开始后继续调整实际服务槽的排队顺序。 */
  priority?: () => number;
  /** 收到job的单调时钟；直接调用Core时省略并以调用开始为起点。 */
  receivedAt?: number;
  onPartial?: (value: { text: string; provider: string; finalOnly?: boolean }) => void;
}
