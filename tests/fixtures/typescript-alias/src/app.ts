import { formatName } from "@/utils/format";
import { missing } from "@/utils/not-there";

export function greet(): string {
  missing();
  return formatName("Ada", "Lovelace");
}
