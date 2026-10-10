/**
 * Shows a photo or video whole (no cropping) on a blurred copy of itself,
 * so the full field of view is always visible and the screen still feels full.
 */
export function Media({
  src,
  kind,
  loop,
  onEnded,
  onDims,
  filter,
  frame,
  overlay,
}: {
  src: string;
  kind: "photo" | "video";
  loop?: boolean;
  onEnded?: () => void;
  onDims?: (d: { w: number; h: number }) => void;
  /** CSS filter for the photo (the editor's looks) */
  filter?: string;
  /** the editor: show it in this rect (where contain puts it) with the viewfinder's rounded corners, no blurred fill */
  frame?: { x: number; y: number; w: number; h: number };
  /** drawn over the media inside the frame (the vignette) */
  overlay?: string;
}) {
  if (frame) {
    const dims = (e: React.SyntheticEvent<HTMLImageElement | HTMLVideoElement>) => {
      const t = e.currentTarget;
      onDims?.(t instanceof HTMLVideoElement ? { w: t.videoWidth, h: t.videoHeight } : { w: t.naturalWidth, h: t.naturalHeight });
    };
    return (
      <div className="absolute overflow-hidden rounded-[24px]" style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }}>
        {kind === "photo" ? (
          <img src={src} alt="" className="h-full w-full object-cover" style={filter ? { filter } : undefined} onLoad={dims} />
        ) : (
          <video src={src} autoPlay loop={loop} playsInline className="h-full w-full object-cover" onLoadedMetadata={dims} onEnded={onEnded} />
        )}
        {overlay && <div className="pointer-events-none absolute inset-0" style={{ background: overlay }} />}
      </div>
    );
  }
  return (
    <>
      {kind === "photo" && (
        <img src={src} alt="" aria-hidden className="absolute inset-0 h-full w-full scale-110 object-cover opacity-60 blur-2xl" />
      )}
      {kind === "photo" ? (
        <img
          src={src}
          alt=""
          className="absolute inset-0 h-full w-full object-contain"
          style={filter ? { filter } : undefined}
          onLoad={(e) => onDims?.({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        />
      ) : (
        <video
          src={src}
          autoPlay
          loop={loop}
          playsInline
          className="absolute inset-0 h-full w-full object-contain"
          style={filter ? { filter } : undefined}
          onLoadedMetadata={(e) => onDims?.({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })}
          onEnded={onEnded}
        />
      )}
    </>
  );
}
