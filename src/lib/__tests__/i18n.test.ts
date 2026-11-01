import { describe, it, expect, vi } from "vitest";
import {
  t,
  translateCategory,
  mountName,
  ifaceName,
  smartLabel,
  formatLastUsedZh,
  translateScanLabel,
  translateItemName,
} from "../../i18n/zh-CN";
import { parseUninstallPreview } from "../mole";

describe("i18n 翻译层", () => {
  it("映射清理分类", () => {
    expect(translateCategory("User essentials")).toBe("用户基础项");
    expect(translateCategory("User app cache")).toBe("应用缓存");
    expect(translateCategory("User app logs")).toBe("应用日志");
    expect(translateCategory("Trash")).toBe("废纸篓");
    expect(translateCategory("App caches")).toBe("应用缓存");
  });

  it("未映射分类 fallback 原文并 console.warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(translateCategory("Some New Category")).toBe("Some New Category");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("映射通用词条", () => {
    expect(t("skipped")).toBe("已跳过");
    expect(t("Files to be removed:")).toBe("将移除以下文件：");
  });

  it("映射挂载点与接口", () => {
    expect(mountName("/")).toBe("Macintosh HD");
    expect(mountName("/Volumes/External HD")).toBe("外置磁盘");
    expect(ifaceName("en0")).toBe("Wi-Fi");
    expect(ifaceName("en5")).toBe("以太网");
    expect(ifaceName("en9")).toBe("网络接口");
  });

  it("SMART 状态转中文", () => {
    expect(smartLabel("verified")).toBe("良好");
    expect(smartLabel(null)).toBe("未知");
    expect(smartLabel("errors")).toBe("需关注");
  });

  it("最近使用时间转中文", () => {
    expect(formatLastUsedZh("Last: 1y ago")).toBe("1 年前");
    expect(formatLastUsedZh("Last: 3mo ago")).toBe("3 个月前");
    expect(formatLastUsedZh("Last: 2h ago")).toBe("2 小时前");
    expect(formatLastUsedZh("nonsense")).toBeNull();
  });

  it("进度标签转人话", () => {
    expect(translateScanLabel("User essentials")).toBe("用户基础项");
    expect(translateScanLabel("/Users/x/Library/Caches")).toBe("应用缓存");
  });

  it("清理条目名转人话", () => {
    expect(translateItemName("User app cache · 27 items")).toBe("应用缓存 · 27 项");
    expect(translateItemName("Trash · skipped, grant Full Disk Access to your terminal")).toBe(
      "废纸篓 · 已跳过：需要完全磁盘访问授权",
    );
  });
});

describe("卸载预览解析", () => {
  it("解析匹配应用、文件与保留项", () => {
    const raw = [
      "DRY RUN MODE, No app files or settings will be modified",
      "",
      "Matched 1 app(s): 1. 腾讯元宝  156.6MB  |  Last: 1y ago",
      "",
      "Files to be removed:",
      "◎ 腾讯元宝 , 156.6MB",
      "✓ /Applications/腾讯元宝.app , 156.6MB",
      "",
      "Personal data kept:",
      "⊙ ~/Library/Application Support/com.tencent.yuanbao",
    ].join("\n");
    const p = parseUninstallPreview(raw, "腾讯元宝");
    expect(p.appSize).toBe("156.6MB");
    expect(p.lastUsedRaw).toBe("Last: 1y ago");
    expect(p.files.some((f) => f.path.endsWith(".app"))).toBe(true);
    expect(p.kept).toHaveLength(1);
  });
});
