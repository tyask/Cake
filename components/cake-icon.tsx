import Image from "next/image";

export function CakeIcon({
  size = 40,
  decorative = false,
  className,
}: {
  size?: number;
  decorative?: boolean;
  className?: string;
}) {
  return (
    <Image
      src="/brand/cake-geometric-icon.svg"
      alt={decorative ? "" : "Cake"}
      width={size}
      height={size}
      className={["cake-icon", className].filter(Boolean).join(" ")}
    />
  );
}
