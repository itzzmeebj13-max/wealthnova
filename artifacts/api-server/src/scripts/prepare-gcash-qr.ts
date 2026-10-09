import { readFile } from "node:fs/promises";
import { prisma } from "@workspace/db";
import { getPaymentSettings } from "../lib/deposits";
import { storePrivateImage, deletePrivateImage } from "../lib/private-images";

// One-time operator import of a user-provided QR, never enables submissions.
try {
  const settings = await getPaymentSettings();
  if (settings.qrImageId) {
    process.stdout.write("An existing QR is configured; it was not replaced.\n");
  } else {
    const path = process.argv[2];
    if (!path) throw new Error("Supply the path of the approved QR image.");
    const root = await prisma.user.findUniqueOrThrow({ where: { mobileNumber: "WEALTHNOVA-ROOT" } });
    const image = await storePrivateImage(root.id, "QR", await readFile(path), "image/jpeg");
    const changed = await prisma.depositPaymentSettings.updateMany({
      where: { id: "gcash", version: settings.version, qrImageId: null, submissionsEnabled: false },
      data: { qrImageId: image.id, version: { increment: 1 } },
    });
    if (!changed.count) {
      await deletePrivateImage(image.objectPath);
      await prisma.depositImage.delete({ where: { id: image.id } });
      throw new Error("Settings changed; the existing configuration was preserved.");
    }
    process.stdout.write("Provided QR stored privately. Account details remain unchanged and submissions are disabled.\n");
  }
} finally { await prisma.$disconnect(); }
