import config from './config';
import * as dgram from 'dgram';

class Logger {
  static priorities = {
    emerg: 0,
    alert: 1,
    crit: 2,
    err: 3,
    warn: 4,
    notice: 5,
    info: 6,
    debug: 7
  };
  static facilities = {
    kern: 0,
    user: 1,
    mail: 2,
    daemon: 3,
    auth: 4,
    syslog: 5,
    lpr: 6,
    news: 7,
    uucp: 8,
    local0: 16,
    local1: 17,
    local2: 18,
    local3: 19,
    local4: 20,
    local5: 21,
    local6: 22,
    local7: 23
  };

  public tags = {
    mining: 'Mining',
    ln: 'Lightning',
  };

  // @ts-ignore
  public emerg: ((msg: string, tag?: string) => void);
  // @ts-ignore
  public alert: ((msg: string, tag?: string) => void);
  // @ts-ignore
  public crit: ((msg: string, tag?: string) => void);
  // @ts-ignore
  public err: ((msg: string, tag?: string) => void);
  // @ts-ignore
  public warn: ((msg: string, tag?: string) => void);
  // @ts-ignore
  public notice: ((msg: string, tag?: string) => void);
  // @ts-ignore
  public info: ((msg: string, tag?: string) => void);
  // @ts-ignore
  public debug: ((msg: string, tag?: string) => void);

  private name = 'mempool';
  private client: dgram.Socket;
  private network: string;

  constructor() {
    let prio;
    for (prio in Logger.priorities) {
      if (true) {
        this.addprio(prio);
      }
    }
    this.client = dgram.createSocket('udp4');
    this.network = this.getNetwork();
  }

  public updateNetwork(): void {
    this.network = this.getNetwork();
  }

  private addprio(prio): void {
    this[prio] = (function (_this) {
      return function (msg, tag?: string) {
        return _this.msg(prio, msg, tag);
      };
    })(this);
  }

  private getNetwork(): string {
    if (config?.LIGHTNING?.ENABLED) {
      return config?.MEMPOOL.NETWORK === 'mainnet' ? 'lightning' : `${config?.MEMPOOL?.NETWORK}-lightning`;
    }
    if (config?.BISQ?.ENABLED) {
      return 'bisq';
    }
    if (config?.MEMPOOL?.NETWORK && config?.MEMPOOL?.NETWORK !== 'mainnet') {
      return config?.MEMPOOL?.NETWORK;
    }
    return '';
  }

  private msg(priority, msg, tag?: string) {
    let consolemsg, prionum, syslogmsg;
    if (typeof msg === 'string' && msg.length > 0) {
      while (msg[msg.length - 1].charCodeAt(0) === 10) {
        msg = msg.slice(0, msg.length - 1);
      }
    }
    const network = this.network ? ' <' + this.network + '>' : '';
    prionum = Logger.priorities[priority] || Logger.priorities.info;
    consolemsg = `${this.ts()} [${process.pid}] ${priority.toUpperCase()}:${network} ${tag ? '[' + tag + '] ' : ''}${msg}`;

    if (config?.SYSLOG?.ENABLED && Logger.priorities[priority] <= Logger.priorities[config?.SYSLOG?.MIN_PRIORITY]) {
      syslogmsg = `<${(Logger.facilities[config?.SYSLOG?.FACILITY] * 8 + prionum)}> ${this.name}[${process.pid}]: ${priority.toUpperCase()}${network} ${tag ? '[' + tag + '] ' : ''}${msg}`;
      this.syslog(syslogmsg);
    }
    if (Logger.priorities[priority] > Logger.priorities[config?.MEMPOOL?.STDOUT_LOG_MIN_PRIORITY]) {
      return;
    }
    if (priority === 'warning') {
      priority = 'warn';
    }
    if (priority === 'debug') {
      priority = 'info';
    }
    if (priority === 'err') {
      priority = 'error';
    }
    return (console[priority] || console.error)(consolemsg);
  }

  private syslog(msg) {
    let msgbuf;
    msgbuf = Buffer.from(msg);
    this.client.send(msgbuf, 0, msgbuf.length, config?.SYSLOG?.PORT, config?.SYSLOG?.HOST, function (err, bytes) {
      if (err) {
        console.log(err);
      }
    });
  }

  private leadZero(n: number): number | string {
    if (n < 10) {
      return '0' + n;
    }
    return n;
  }

  private ts() {
    let day, dt, hours, minutes, month, months, seconds;
    dt = new Date();
    hours = this.leadZero(dt.getHours());
    minutes = this.leadZero(dt.getMinutes());
    seconds = this.leadZero(dt.getSeconds());
    month = dt.getMonth();
    day = dt.getDate();
    if (day < 10) {
      day = ' ' + day;
    }
    months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return months[month] + ' ' + day + ' ' + hours + ':' + minutes + ':' + seconds;
  }
}

export default new Logger();
