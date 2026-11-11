# 已有素材到单场景

输入：悠（背景），编排登记路径 assets/<来源存储键>/dansei_16_a.png，命令引用 <来源存储键>/dansei_16_a.png。剧情：学生林在末班车前与朋友道别。

写入授权 game/scene/start.txt：

```text
changeBg:<来源存储键>/dansei_16_a.png;
bgm:<来源存储键>/theme.ogg -volume=60;
say:末班车快到了，我们明天见。 -speaker=林;
say:车站的灯亮了。 -clear;
bgm:none;
end;
```

回读确认字节，返回采用素材 station。读取链应定位第 1 行背景引用，再由领域检查；示例本身不代表本次生成成功。
