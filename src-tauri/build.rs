fn main() {
    tauri_build::build();

    // 图标是打包时嵌进 exe 的 Windows 资源，而 `tauri_build` 只为
    // `tauri.conf.json` 和 `capabilities/` 发 rerun-if-changed，**不包含 `icons/`**。
    //
    // 后果很隐蔽：`tauri icon` 换掉 `icons/icon.ico` 之后，cargo 认为构建脚本
    // 是新鲜的、不重跑，那份旧图标的资源就原样留在 exe 里。表现出来是
    // 「重新构建了，任务栏图标却没变」，而且构建还正常成功，没有任何提示。
    //
    // 补上这一条，重切图标之后普通构建就能生效。
    println!("cargo:rerun-if-changed=icons");
}
