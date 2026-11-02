/** 把节点搬到宿主给的落点；落点要随组件销毁一起清掉，否则节点会留在宿主里。 */
export function portal(node: HTMLElement, target: HTMLElement | null) {
  const place = (to: HTMLElement | null) => {
    if (to) to.append(node);
  };
  place(target);
  return {
    update: place,
    destroy: () => node.remove(),
  };
}
