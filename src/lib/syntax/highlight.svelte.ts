/**
 * 组件侧的高亮订阅：给定（随状态变化的）语言与行，返回按行读取分词结果的函数。
 *
 * 结果逐块到达，每到一块只递增一个版本号——读取方在模板里调用 at(i) 时订阅这个版本号，
 * 因此只有可见行会重新渲染，不会为几万行的数组做整份拷贝。
 * 语言或内容变化时取消旧请求；组件销毁时一并取消。
 */

import { untrack } from "svelte";
import { highlightLines, type SyntaxLine } from "./client";

export interface HighlightHandle {
  /** 第 i 行的分词结果；尚未完成或不高亮时为 undefined（按纯文本显示）。 */
  at: (index: number) => SyntaxLine | undefined;
  /** 是否全部完成（不高亮时也视为完成）。 */
  ready: () => boolean;
}

export function createHighlight(source: () => { lang: string | null; lines: string[] }): HighlightHandle {
  let version = $state(0);
  let done = $state(true);
  let store: (SyntaxLine | undefined)[] = [];

  /* 递增版本号必须不被追踪：命中缓存时结果在 effect 执行期间同步送达，
     直接 version += 1 会让 effect 读到自己写的状态而无限重跑。 */
  const bump = () => untrack(() => (version += 1));

  $effect(() => {
    const { lang, lines } = source();
    return untrack(() => {
      const local: (SyntaxLine | undefined)[] = [];
      store = local;
      bump();
      if (!lang || lines.length === 0) {
        done = true;
        return undefined;
      }
      done = false;
      return highlightLines(
        lang,
        lines,
        (start, chunk) => {
          for (let index = 0; index < chunk.length; index += 1) local[start + index] = chunk[index];
          if (store === local) bump();
        },
        () => {
          if (store === local) done = true;
        },
      );
    });
  });

  return {
    at(index) {
      void version;
      return store[index];
    },
    ready() {
      return done;
    },
  };
}
