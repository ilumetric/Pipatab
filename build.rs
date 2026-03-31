use std::path::Path;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=ts/lib.ts");

    let js_needs_update = || -> Result<bool, Box<dyn std::error::Error>> {
        let ts_modified = Path::new("ts/lib.ts").metadata()?.modified()?;
        let js_modified = Path::new("www/static/lib.js").metadata()?.modified()?;
        Ok(ts_modified > js_modified)
    }()
    .unwrap_or(true);

    if js_needs_update {
        let status = Command::new("cmd")
            .args(["/C", "tsc"])
            .status();

        let status = match status {
            Ok(s) => s,
            Err(err) => {
                println!("cargo:warning=Failed to call tsc: {err}");
                std::process::exit(1);
            }
        };

        if !status.success() {
            match status.code() {
                Some(code) => println!("cargo:warning=tsc failed with exitcode: {code}"),
                None => println!("cargo:warning=tsc terminated by signal."),
            };
            std::process::exit(2);
        }
    }
}
