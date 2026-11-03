/**
 * Keeps a MoQ group backlog off the screen.
 *
 * A MoQ subscription starts on the track's current group from its first
 * frame, and the relay keeps that group however old it is. simulator-server
 * cuts a group only at a keyframe and forces one every 600 repaints, so a
 * viewer that joins a stream can be handed everything drawn since the last
 * keyframe in one burst. `@moq/watch`'s `Sync` re-anchors its clock on every
 * frame that arrives early, so the decoder releases the whole burst at decode
 * speed and `Video.Renderer` paints it: a sped-up replay before the live
 * picture. The frames still have to be decoded (each depends on the one
 * before), but only the ones at the live edge are worth painting.
 */
import { Time } from "@moq/net";
import { type Signals, Sync } from "@moq/watch";

/**
 * Slack past the jitter buffer before a decoded frame counts as backlog. In
 * steady state a frame is painted about one jitter buffer after it arrives, by
 * which time the track has received frames about that much newer. A frame
 * further behind the newest one than buffer plus slack is being decoded at
 * full speed to catch up, not played live.
 */
export const BACKLOG_SLACK = Time.Milli(500);

/** The playback clock, plus the live edge: the newest timestamp received since the last rewind. */
export class LiveEdgeSync extends Sync {
  #newest: Time.Milli | undefined;

  override received(timestamp: Time.Milli, label?: string): void {
    super.received(timestamp, label);
    if (this.#newest === undefined || timestamp > this.#newest) this.#newest = timestamp;
  }

  override reset(): void {
    super.reset();
    this.#newest = undefined;
  }

  /** Whether a frame at `timestamp` sits further behind the live edge than live video does. */
  isBacklog(timestamp: Time.Milli): boolean {
    if (this.#newest === undefined) return false;
    const budget = Time.Milli.add(this.out.buffer.peek(), BACKLOG_SLACK);
    return Time.Milli.sub(this.#newest, timestamp) > budget;
  }
}

/** The part of {@link LiveEdgeSync} the painter needs. */
export interface BacklogCheck {
  isBacklog(timestamp: Time.Milli): boolean;
}

/**
 * Paints `frames` onto `canvas`, one per animation frame, skipping the ones
 * `sync` reports as backlog. Replaces `Video.Renderer`, which paints every
 * frame the decoder releases. Returns a function that stops painting.
 */
export function paintLiveFrames(
  frames: Signals.Getter<VideoFrame | undefined>,
  sync: BacklogCheck,
  canvas: HTMLCanvasElement,
): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("the video canvas has no 2d context");

  // The frame waiting for the next animation frame, cloned so the decoder
  // closing its own copy cannot pull it out from under the paint.
  let pending: VideoFrame | undefined;
  let animate: number | undefined;

  const cancel = () => {
    if (animate !== undefined) cancelAnimationFrame(animate);
    animate = undefined;
    pending?.close();
    pending = undefined;
  };

  const unsubscribe = frames.subscribe((frame) => {
    cancel();
    if (!frame) return;
    if (sync.isBacklog(Time.Milli.fromMicro(frame.timestamp as Time.Micro))) return;
    pending = frame.clone();
    animate = requestAnimationFrame(() => {
      animate = undefined;
      const next = pending;
      pending = undefined;
      if (!next) return;
      ctx.drawImage(next, 0, 0, canvas.width, canvas.height);
      next.close();
    });
  });

  return () => {
    unsubscribe();
    cancel();
  };
}
