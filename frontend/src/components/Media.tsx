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
}: {
  src: string;
  kind: "photo" | "video";
  loop?: boolean;
  onEnded?: () => void;
  onDims?: (d: { w: number; h: number }) => void;
  /** CSS filter for the photo (the editor's looks) */
  filter?: string;
}) {
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
