# Proxy instructions

**Important: This page is hard "Work in progress", and I explicitly request support in form of images that describe the process from an end user perspective and all infos. Please support!**

## Starting the Proxy
The Proxy ist started using the Adapter configuration page in ioBroker. Read the information there and click the "Start Proxy" button.

In the configuration you can set:
1. One port for the proxy-server. This is the port you will configure on the client device's proxy settings (default: 8888).
2. The second port provides a simple webpage to guide you through the process (default: 8889).
3. Set the optional "Proxy External IP" if you use Docker and so the IP of the ioBroker host is not the externally reachable IP. The webpage that guides you through the process will then show this external IP. 

* Open the  webpage (http://ip_addr:8889 by default)
  <img width="300" alt="initial_webpage" src="https://user-images.githubusercontent.com/65073191/124582164-0fe0b000-de52-11eb-8dad-8dec4db7b0e5.png">

* Click on first link to download the certificate and enable it (see below for client device specific flow)
* When done click on the second Link to login to the Daikin Cloud
* After a successful login the browser should currently (to be optimized) show an error message (or simply stay on a Daikin page or show a blank page) because the last page is not possible to be opened by any browser. BUT if the console shows success that tokens were able to be catched we are already done!

Info: This adapter is not grabbing any username or password, just the created tokens after you logged in.
**If Daikin resets the tokens or such then it might be needed to do this proxy process again.**

## Setting up client device

The following page contains instructions for setting up a client device to do this process. For example Windows, macOS, iOS and Android are described there.

https://github.com/Apollon77/daikin-controller-cloud/blob/main/PROXY.md#setting-up-client-device
