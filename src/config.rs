use std::net::IpAddr;
use clap::Parser;

#[derive(Parser, Debug, Clone)]
#[command(name = "pipatab", version, about = "Wireless graphics tablet for artists")]
pub struct Config {
    #[arg(long, help = "Access code to restrict connections")]
    pub access_code: Option<String>,

    #[arg(long, default_value = "0.0.0.0", help = "Bind address")]
    pub bind_address: IpAddr,

    #[arg(long, default_value = "1701", help = "Web server port")]
    pub web_port: u16,

    #[arg(long, default_value = "0", help = "Target monitor index (0 = primary)")]
    pub monitor: usize,
}

pub fn get_config() -> Config {
    Config::parse()
}
