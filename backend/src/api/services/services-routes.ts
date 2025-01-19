import { Application, Request, Response } from 'express';
import config from '../../config';
import WalletApi from './wallets';
import { handleError } from '../../utils/api';

class ServicesRoutes {
  public initRoutes(app: Application): void {
    app
      .get(config.MEMPOOL.API_URL_PREFIX + 'wallet/:walletId', this.$getWallet)
      .get(config.MEMPOOL.API_URL_PREFIX + 'services/custom/config', this.$getCustomConfig)
    ;
  }

  private async $getWallet(req: Request, res: Response): Promise<void> {
    try {
      res.header('Pragma', 'public');
      res.header('Cache-control', 'public');
      res.setHeader('Expires', new Date(Date.now() + 1000 * 5).toUTCString());
      const walletId = req.params.walletId;
      const wallet = await WalletApi.getWallet(walletId);
      res.status(200).send(wallet);
    } catch (e) {
      handleError(req, res, 500, 'Failed to get wallet');
    }
  }

  // serve a blank custom config file by default
  private async $getCustomConfig(req: Request, res: Response): Promise<void> {
    res.status(200).contentType('application/javascript').send('');
  }
}

export default new ServicesRoutes();
