# 诊断修正

repair 模式读取真实候选和当前 diagnostics、commandLocations。按问题码定位源文件和语句，先用 readTextRange 读取当前文本，再用 replaceText（明确 expectedMatches）或 writeText 修改必要内容。

引用错误先核对 assetBindings，而不是猜新文件名。语法和参数问题先核对锁定版本。`unknown-command` 改成当前解析器支持的命令。`unsupported-dialogue` 把角色简写、裸行和空说话人改成 `say:... -speaker=姓名;` 或 `say:... -clear;`。保留仍有效的剧情、演出和已确认约束，不把命令改写成台词，也不猜测裸行本意。

修改后回读实际文件，将候选交回工作流保存新修订、重新解析和领域判断。不能自己宣布校验或提交成功。预算耗尽或无法修正时返回具体未解决事项，不能用空文件规避。
