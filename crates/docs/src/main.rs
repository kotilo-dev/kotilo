//! `agenthub-docs` (shipped as `<exePrefix>-docs`): thin shell around [`agenthub_docs::cli::run`].

fn main() {
    // `args_os` + lossy conversion: a non-Unicode argument never panics.
    let args: Vec<String> = std::env::args_os().skip(1).map(|a| a.to_string_lossy().into_owned()).collect();
    let cwd = match std::env::current_dir() {
        Ok(dir) => dir,
        Err(e) => {
            eprintln!("error: cannot read the current folder: {e}");
            std::process::exit(agenthub_docs::cli::EXIT_ERROR);
        }
    };
    let color = agenthub_docs::cli::want_color();
    let code = agenthub_docs::cli::run(&args, &cwd, &mut std::io::stdout().lock(), &mut std::io::stderr().lock(), color);
    std::process::exit(code);
}
