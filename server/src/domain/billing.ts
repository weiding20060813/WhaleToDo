// 商品、订单与模拟支付：纯函数状态机
// 契约要点：
//   · 金额与币种以服务端商品快照为准，客户端只提交 product_id
//   · 订单幂等键 (user_id, idempotency_key)；支付事件幂等键 (provider, event_id)
//   · 只有服务端核验通过才发放权益；客户端"支付成功"页面不能作为入账依据
//   · mock 通道仅在 test/demo 启用；生产环境配置 mock 必须拒绝启动（见 config.ts）
import { ApiError } from '../lib/security.ts';

export type OrderStatus = 'PENDING' | 'PAID' | 'CLOSED' | 'REFUNDED';
export type PaymentProvider = 'mock' | 'real';

export interface Product {
  productId: string;
  title: string;
  priceMinor: number;
  currency: string;
  vipDays: number;
  points: number;
  active: boolean;
}

export interface Order {
  id: string;
  userId: string;
  productId: string;
  amountMinor: number;
  currency: string;
  status: OrderStatus;
  idempotencyKey: string;
  environment: 'mock' | 'production';
  createdAt: number;
  paidAt: number | null;
}

export interface PaymentEvent {
  provider: PaymentProvider;
  eventId: string;
  orderId: string;
  status: 'succeeded' | 'failed' | 'refunded';
  amountMinor: number;
  currency: string;
  receivedAt: number;
}

export interface Entitlement {
  kind: 'vip';
  expiresAt: number;
  sourceOrderId: string;
}

/** 建单：金额、币种、权益都由服务端商品决定 */
export function buildOrder(input: {
  id: string;
  userId: string;
  product: Product;
  idempotencyKey: string;
  environment: 'mock' | 'production';
  now: number;
}): Order {
  const { product } = input;
  if (!product.active) throw new ApiError('CONFLICT', '商品已下架');
  if (!Number.isInteger(product.priceMinor) || product.priceMinor < 0) {
    throw new ApiError('VALIDATION_ERROR', '商品价格非法');
  }
  if (!/^[A-Z]{3}$/.test(product.currency)) throw new ApiError('VALIDATION_ERROR', '商品币种非法');
  if (!input.idempotencyKey) throw new ApiError('VALIDATION_ERROR', '缺少 Idempotency-Key');

  return {
    id: input.id,
    userId: input.userId,
    productId: product.productId,
    amountMinor: product.priceMinor,
    currency: product.currency,
    status: 'PENDING',
    idempotencyKey: input.idempotencyKey,
    environment: input.environment,
    createdAt: input.now,
    paidAt: null,
  };
}

/**
 * 应用支付结果：已支付视为幂等成功；金额/币种不符直接拒绝。
 * 返回新订单、需要发放的权益（若有）以及是否发生了状态变化。
 */
export function applyPaymentResult(
  order: Order,
  event: Pick<PaymentEvent, 'eventId' | 'status' | 'amountMinor' | 'currency'>,
  product: Product,
  now: number,
): { order: Order; entitlement: Entitlement | null; changed: boolean } {
  if (event.status === 'failed') {
    return { order: { ...order, status: order.status === 'PAID' ? 'PAID' : 'CLOSED' }, entitlement: null, changed: order.status !== 'PAID' };
  }

  if (event.status === 'refunded') {
    if (order.status === 'PENDING') throw new ApiError('CONFLICT', '订单未支付，无法退款');
    return { order: { ...order, status: 'REFUNDED' }, entitlement: null, changed: true };
  }

  // succeeded
  if (event.amountMinor !== order.amountMinor) {
    throw new ApiError('VALIDATION_ERROR', '支付金额与订单不一致', {
      expected: order.amountMinor, actual: event.amountMinor,
    });
  }
  if (event.currency !== order.currency) {
    throw new ApiError('VALIDATION_ERROR', '支付币种与订单不一致', {
      expected: order.currency, actual: event.currency,
    });
  }
  if (order.status === 'PAID') {
    return { order, entitlement: null, changed: false };   // 重复事件：幂等
  }
  if (order.status === 'REFUNDED') throw new ApiError('CONFLICT', '订单已退款，不能再次支付');

  const paid: Order = { ...order, status: 'PAID', paidAt: now };
  const entitlement: Entitlement | null =
    product.vipDays > 0
      ? { kind: 'vip', expiresAt: now + product.vipDays * 24 * 60 * 60 * 1000, sourceOrderId: order.id }
      : null;
  return { order: paid, entitlement, changed: true };
}

/** 模拟支付回调只允许在 mock 通道下处理，且必须校验内部令牌 */
export function assertMockWebhookAllowed(provider: string, token: string | null, expected: string | null): void {
  if (provider !== 'mock') {
    throw new ApiError('FORBIDDEN', '当前支付通道未启用模拟回调');
  }
  if (!expected || !token || token !== expected) {
    throw new ApiError('FORBIDDEN', '模拟回调令牌校验失败');
  }
}
