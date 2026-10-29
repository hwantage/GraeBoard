import { z } from "zod";

// Images are resized by the profile editor before being stored. Only raster
// data URLs are accepted; remote URLs and SVG cannot become avatar sources.
export const profileFields = {
  color: z
    .string()
    .regex(/^#[a-fA-F0-9]{6}$/)
    .optional(),
  avatarInitials: z
    .string()
    .trim()
    .regex(
      /^(?:[a-zA-Z0-9]{1,3}|[가-힣]{1,2})?$/u,
      "아바타 글자는 영문·숫자 1~3자 또는 한글 1~2자를 입력하세요.",
    )
    .optional(),
  avatarImage: z
    .string()
    .max(150000)
    .refine((value) => {
      if (!value) return true;
      const match = value.match(
        /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/,
      );
      if (!match || match[2].length % 4) return false;
      const bytes = Buffer.from(match[2], "base64");
      if (match[1] === "png")
        return bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      if (match[1] === "jpeg")
        return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      return (
        bytes.toString("ascii", 0, 4) === "RIFF" &&
        bytes.toString("ascii", 8, 12) === "WEBP"
      );
    }, "PNG, JPEG, WebP 형식의 아바타 이미지를 선택하세요.")
    .optional(),
};

export function profileSnapshot({
  id,
  name,
  color,
  avatarInitials,
  avatarImage,
}) {
  return { id, name, color, avatarInitials, avatarImage };
}
