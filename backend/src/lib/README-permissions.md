# Remote workstation user detection permissions

The backend attempts to read the **interactive logged-in user** per workstation:

1. PowerShell CIM/WMI query:
   - `Get-CimInstance -ClassName Win32_ComputerSystem -ComputerName <PC> | Select -Expand UserName`
2. Fallback:
   - `quser /server:<PC>`

## Required permissions

- The Windows account running the backend must be permitted to query WMI remotely on the target machines.
- Firewalls must allow the relevant RPC/WMI traffic.

Recommended model:

- Run the backend as a dedicated domain service account.
- Use GPO to grant that account remote WMI query rights (least privilege).

If permissions are missing, the UI will show `Unknown` for logged-in user and include the error message in a tooltip.
